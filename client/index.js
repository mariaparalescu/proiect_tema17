const { io } = require('socket.io-client');
const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const { program } = require('commander');
const chalk = require('chalk');

class FileSystemClient {
    constructor(serverUrl = 'http://localhost:3000', localDir = './local') {
        this.serverUrl = serverUrl;
        this.localDir = path.normalize(path.resolve(localDir));
        this.socket = null;
        this.watcher = null;
        this.isInitialSync = true;
        this.activeOperations = new Set();
        this.fileModes = new Map();
        console.log(chalk.blue(`[Client] Initializing with:`));
        console.log(chalk.blue(`  - Server URL: ${this.serverUrl}`));
        console.log(chalk.blue(`  - Local directory: ${this.localDir}`));
        try {
            fs.ensureDirSync(this.localDir);
            console.log(chalk.green(`[Client] Local directory created/verified: ${this.localDir}`));
            const testFile = path.join(this.localDir, '.test');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            console.log(chalk.green('[Client] Write permissions verified for local directory'));
        } catch (error) {
            console.error(chalk.red('[Client] CRITICAL ERROR setting up local directory:'), error);
            process.exit(1);
        }
    }
    
    async connect() {
        console.log(chalk.blue(`[Client] Connecting to server at ${this.serverUrl}...`));
        
        this.socket = io(this.serverUrl, {
            reconnectionAttempts: 5, // Try to reconnect a few times
            reconnectionDelay: 3000,  // Wait 3 seconds between attempts
        });
        
        this.socket.on('connect', () => {
            console.log(chalk.green('[Client] Connected to server. Socket ID: ') + this.socket.id);
        });
        
        this.socket.on('disconnect', (reason) => {
            console.log(chalk.yellow(`[Client] Disconnected from server. Reason: ${reason}`));
            if (reason === 'io server disconnect') {
                // The server intentionally disconnected the socket, probably not recoverable
                this.socket.connect(); // Or handle as a permanent error
            }
            // else the socket will automatically try to reconnect
        });
        
        this.socket.on('connect_error', (error) => {
            console.error(chalk.red('[Client] Connection Error:'), error.message);
        });

        this.socket.on('operationError', (error) => {
            console.error(chalk.red('[Client] Received operation error from server:'), error);
        });
        
        this.socket.on('fileSystemState', async (files) => {
            console.log(chalk.blue('[Client] Received initial file system state from server.'));
            console.log(chalk.blue(`  - Found ${files.length} remote items to sync.`));
            this.isInitialSync = true; // Ensure this is set before sync
            await this.syncWithServer(files);
            this.isInitialSync = false;
            console.log(chalk.green('[Client] Initial sync complete.'));
            this.setupWatcher();
        });
        
        this.socket.on('fileSystemChange', async (data) => {
            console.log(chalk.magentaBright('[Client] Received fileSystemChange from server:'), data);
            if (this.isInitialSync && data.event !== 'addDir' && data.event !== 'add') {
                 // During initial sync, we primarily rely on the full state from syncWithServer.
                 // Only process add/addDir if they somehow arrive during this window to create base structure.
                 // Most other events (change, unlink) for items being synced might be redundant or conflicting.
                console.log(chalk.yellow('[Client] Ignoring event during initial sync window (unless add/addDir): ') + data.event);
                // return; // Decided to allow processing to see if it helps with complex syncs
            }
            const operationKey = `${data.event}-${data.path}`;
            if (this.activeOperations.has(operationKey)) {
                console.log(chalk.cyan(`[Client] Ignoring server event for already active local operation: ${operationKey}`));
                return;
            }
            if (data.event === 'chmod' && data.mode) {
                await this.applyChmod(data.path, data.mode);
                return;
            }
            await this.handleServerChange(data);
        });

        this.socket.on('fileContent', async (data) => {
            const { path: filePath, content, encoding } = data;
            const fullPath = path.join(this.localDir, filePath);
            console.log(chalk.blue(`[Client] Received content for file from server: ${filePath}`));
            const operationKey = `write-${filePath}`;
            this.activeOperations.add(operationKey);
            try {
                await fs.ensureDir(path.dirname(fullPath)); 
                await fs.writeFile(fullPath, Buffer.from(content, encoding || 'base64'));
                console.log(chalk.green(`[Client] Written server content to local file: ${fullPath}`));
            } catch (error) {
                console.error(chalk.red(`[Client] Error writing server file content for ${filePath}:`), error);
            } finally {
                this.activeOperations.delete(operationKey);
            }
        });
    }
    
    setupWatcher() {
        if (this.watcher) {
            console.log(chalk.yellow('[Client] Watcher already setup. Closing existing one.'));
            this.watcher.close();
        }
        console.log(chalk.blue(`[Client] Setting up file watcher for: ${this.localDir}`));
        try {
            this.watcher = chokidar.watch(this.localDir, {
                ignored: /(^|[\/\\])\../, 
                persistent: true,
                ignoreInitial: true,
                depth: 99, // Watch subdirectories
                usePolling: process.platform === 'darwin' // Use polling on macOS if native FSEvents are problematic
            });
            console.log(chalk.blue('[Client] chokidar.watch called. Setting up event handlers...'));

            this.watcher
                .on('ready', async () => {
                    console.log(chalk.green('[Client] File watcher is ready and watching.'));
                    await this.cacheFileModes();
                    this.startModePolling();
                })
                .on('all', (event, filePath) => {
                    console.log(chalk.cyan(`[Client Watcher Raw Event] Event: ${event}, Path: ${filePath}`));
                    if (!filePath) return;
                })
                .on('add', (filePath) => this.handleLocalChange('add', filePath))
                .on('change', (filePath) => this.handleLocalChange('change', filePath))
                .on('unlink', (filePath) => this.handleLocalChange('unlink', filePath))
                .on('addDir', (dirPath) => this.handleLocalChange('addDir', dirPath))
                .on('unlinkDir', (dirPath) => this.handleLocalChange('unlinkDir', dirPath))
                .on('error', (error) => {
                    console.error(chalk.red('[Client] Watcher instance error event:'), error);
                });
            console.log(chalk.blue('[Client] Event handlers set up for watcher.'));
        } catch (error) {
            console.error(chalk.red('[Client] CRITICAL ERROR during chokidar.watch setup:'), error);
            if (this.socket) this.socket.disconnect();
        }
    }
    
    async cacheFileModes() {
        const files = await this.getLocalFiles();
        for (const file of files) {
            const fullPath = path.join(this.localDir, file.path);
            try {
                const stat = await fs.stat(fullPath);
                this.fileModes.set(file.path, stat.mode & 0o777);
            } catch {}
        }
    }
    
    async handleLocalChange(event, filePath) {
        if (this.isInitialSync) {
            console.log(chalk.yellow(`[Client] Ignoring local change during initial sync period: ${event} on ${filePath}`));
            return;
        }
        
        const relativePath = path.relative(this.localDir, filePath);
        if (!relativePath) {
             console.log(chalk.yellow(`[Client] Ignoring local change for root directory or empty relative path: ${event} on ${filePath}`));
            return;
        }

        const operationKey = `${event}-${relativePath}`;
        if (this.activeOperations.has(operationKey)) {
            console.log(chalk.cyan(`[Client] Operation already active, probably due to server update: ${operationKey}. Skipping send.`));
            return;
        }
        this.activeOperations.add(operationKey);
        console.log(chalk.blue(`[Client] Processing local change: ${event} on ${relativePath}`));
        
        try {
            const opData = { path: relativePath };            
            let stat;
            switch (event) {
                case 'add':
                case 'change':
                    opData.operation = 'write';
                    const content = await fs.readFile(filePath);
                    opData.content = content.toString('base64');
                    opData.encoding = 'base64';
                    stat = await fs.stat(filePath);
                    if (this.fileModes.get(relativePath) !== (stat.mode & 0o777)) {
                        this.fileModes.set(relativePath, stat.mode & 0o777);
                        this.socket.emit('fileOperation', { operation: 'chmod', path: relativePath, mode: stat.mode & 0o777 });
                        console.log(chalk.blue(`  - Will send 'chmod' for ${relativePath} to mode ${(stat.mode & 0o777).toString(8)}`));
                    }
                    console.log(chalk.blue(`  - Will send 'write' for ${relativePath}`));
                    break;
                case 'unlink':
                    opData.operation = 'delete';
                    console.log(chalk.blue(`  - Will send 'delete' for ${relativePath} (file)`));
                    this.fileModes.delete(relativePath);
                    break;
                case 'addDir':
                    opData.operation = 'mkdir';
                    stat = await fs.stat(filePath);
                    this.fileModes.set(relativePath, stat.mode & 0o777);
                    this.socket.emit('fileOperation', { operation: 'chmod', path: relativePath, mode: stat.mode & 0o777 });
                    console.log(chalk.blue(`  - Will send 'mkdir' for ${relativePath}`));
                    break;
                case 'unlinkDir':
                    opData.operation = 'delete';
                    console.log(chalk.blue(`  - Will send 'delete' for ${relativePath} (directory)`));
                    this.fileModes.delete(relativePath);
                    break;
                default:
                    console.log(chalk.yellow(`[Client] Unknown local event type: ${event}. Ignoring.`));
                    this.activeOperations.delete(operationKey);
                    return;
            }
            this.socket.emit('fileOperation', opData);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log(chalk.yellow(`[Client] File/Dir not found for local change ${relativePath} (likely already deleted). Ignoring.`));
            } else {
                console.error(chalk.red(`[Client] Error handling local change ${event} for ${relativePath}:`), error);
            }
        } finally {

            setTimeout(() => this.activeOperations.delete(operationKey), 500);
        }
    }
    
    async applyChmod(relativePath, mode) {
        const fullPath = path.join(this.localDir, relativePath);
        try {
            await fs.chmod(fullPath, mode);
            this.fileModes.set(relativePath, mode);
            console.log(chalk.green(`[Client] Applied chmod ${mode.toString(8)} to ${fullPath}`));
        } catch (error) {
            console.error(chalk.red(`[Client] Failed to apply chmod ${mode.toString(8)} to ${fullPath}:`), error);
        }
    }
    
    async handleServerChange(data) {
        const { event, path: relativePath, content, encoding } = data;
        const fullPath = path.join(this.localDir, relativePath);
        console.log(chalk.blue(`[Client] Processing server event: ${event} on ${relativePath}`));

        const operationKey = `${event}-${relativePath}`;
        this.activeOperations.add(operationKey);

        try {
            switch (event) {
                case 'add':
                case 'change':
                    if (typeof content !== 'string') {
                        console.error(chalk.red(`[Client] Invalid content received from server for ${relativePath}. Expected base64 string.`));
                        break;
                    }
                    console.log(chalk.blue(`  - Will write/update local file: ${fullPath}`));
                    await fs.ensureDir(path.dirname(fullPath));
                    await fs.writeFile(fullPath, Buffer.from(content, encoding || 'base64'));
                    console.log(chalk.green(`  - Local file updated: ${fullPath}`));
                    break;
                case 'unlink':
                    console.log(chalk.blue(`  - Will delete local file: ${fullPath}`));
                    await fs.remove(fullPath);
                    console.log(chalk.green(`  - Local file deleted: ${fullPath}`));
                    break;
                case 'addDir':
                    console.log(chalk.blue(`  - Will create local directory: ${fullPath}`));
                    await fs.ensureDir(fullPath);
                    console.log(chalk.green(`  - Local directory created: ${fullPath}`));
                    break;
                case 'unlinkDir':
                    console.log(chalk.blue(`  - Will delete local directory: ${fullPath}`));
                    await fs.remove(fullPath);
                    console.log(chalk.green(`  - Local directory deleted: ${fullPath}`));
                    break;
                default:
                    console.log(chalk.yellow(`[Client] Unknown server event type: ${event}. Ignoring.`));
            }
        } catch (error) {
            console.error(chalk.red(`[Client] Error applying server change ${event} for ${relativePath}:`), error);
        } finally {
            this.activeOperations.delete(operationKey);
        }
    }
    
    async syncWithServer(files) {
        console.log(chalk.blue('[Client] Starting initial synchronization with server...'));
        const localFilePaths = new Set((await this.getLocalFiles()).map(f => f.path));
        const serverFilePaths = new Set(files.map(f => f.path));

        // Delete local files not on server
        for (const localPath of localFilePaths) {
            if (!serverFilePaths.has(localPath)) {
                const fullPath = path.join(this.localDir, localPath);
                console.log(chalk.yellow(`  [Sync] Deleting local item not on server: ${localPath}`));
                this.activeOperations.add(`delete-${localPath}`);
                await fs.remove(fullPath);
                this.activeOperations.delete(`delete-${localPath}`);
            }
        }

        // Create/update local files from server state
        for (const file of files) {
            const fullPath = path.join(this.localDir, file.path);
            const operationKey = `${file.type === 'directory' ? 'mkdir' : 'write'}-${file.path}`;
            this.activeOperations.add(operationKey);
            if (file.type === 'directory') {
                console.log(chalk.blue(`  [Sync] Ensuring local directory exists: ${file.path}`));
                await fs.ensureDir(fullPath);
            } else {
                console.log(chalk.blue(`  [Sync] Requesting content for server file: ${file.path}`));

                this.socket.emit('requestFileContent', { path: file.path }); 
            }

            if (file.type === 'directory') {
                 this.activeOperations.delete(operationKey);
            }
        }
        await this.cacheFileModes();
        console.log(chalk.green('[Client] Initial sync pass for deletions and directory structure complete. File contents are being fetched.'));
    }
    
    async getLocalFiles(currentPath = this.localDir, relativeBasePath = '') {
        const items = [];
        try {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue; 
                const entryRelativePath = path.join(relativeBasePath, entry.name);
                const entryAbsolutePath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    items.push({ path: entryRelativePath, type: 'directory' });
                    items.push(...await this.getLocalFiles(entryAbsolutePath, entryRelativePath));
                } else if (entry.isFile()) {
                    const stats = await fs.stat(entryAbsolutePath);
                    items.push({ path: entryRelativePath, type: 'file', size: stats.size });
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                 console.error(chalk.red(`[FS] Error reading local directory ${currentPath} for getLocalFiles:`), error);
            }
        }
        return items;
    }

    startModePolling() {
        setInterval(async () => {
            const files = await this.getLocalFiles();
            for (const file of files) {
                const fullPath = path.join(this.localDir, file.path);
                try {
                    const stat = await fs.stat(fullPath);
                    const currentMode = stat.mode & 0o777;
                    if (this.fileModes.get(file.path) !== currentMode) {
                        this.fileModes.set(file.path, currentMode);
                        this.socket.emit('fileOperation', { operation: 'chmod', path: file.path, mode: currentMode });
                        console.log(chalk.blue(`[Client] Detected chmod for ${file.path} to mode ${currentMode.toString(8)}`));
                    }
                } catch {}
            }
        }, 2000);
    }
}

program
    .option('-s, --server <url>', 'Server URL', 'http://localhost:3000')
    .option('-d, --dir <path>', 'Local directory path', './local')
    .parse(process.argv);

const options = program.opts();

const client = new FileSystemClient(options.server, options.dir);
client.connect(); 