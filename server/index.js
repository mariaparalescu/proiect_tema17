const { Server } = require('socket.io');
const http = require('http');
const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const { program } = require('commander');
const chalk = require('chalk');

class FileSystemServer {
    constructor(port = 3000, watchDir = './shared') {
        this.port = port;
        this.watchDir = path.normalize(path.resolve(watchDir));
        this.clients = new Set();
        
        console.log(chalk.blue(`Initializing server with:`));
        console.log(chalk.blue(`- Port: ${this.port}`));
        console.log(chalk.blue(`- Watch directory: ${this.watchDir}`));
        
        try {
            fs.ensureDirSync(this.watchDir);
            console.log(chalk.green(`Watch directory created/verified: ${this.watchDir}`));
            const testFile = path.join(this.watchDir, '.test');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            console.log(chalk.green('Write permissions verified'));
        } catch (error) {
            console.error(chalk.red('Error setting up watch directory:'), error);
            process.exit(1);
        }
        
        this.server = http.createServer();
        this.io = new Server(this.server);
        
        this.watcher = chokidar.watch(this.watchDir, {
            ignored: /(^|[\/\\])\../,
            persistent: true,
            ignoreInitial: true
        });
        
        this.setupWatcher();
        this.setupSocketHandlers();
    }
    
    setupWatcher() {
        console.log(chalk.blue('Setting up file watcher...'));
        this.watcher
            .on('ready', () => {
                console.log(chalk.green('File watcher is ready'));
            })
            .on('add', (filePath) => {
                console.log(chalk.green(`[Server Watcher] File added: ${filePath}`));
                this.handleFileChange('add', filePath);
            })
            .on('change', (filePath) => {
                console.log(chalk.yellow(`[Server Watcher] File changed: ${filePath}`));
                this.handleFileChange('change', filePath);
            })
            .on('unlink', (filePath) => {
                console.log(chalk.red(`[Server Watcher] File deleted: ${filePath}`));
                this.handleFileChange('unlink', filePath);
            })
            .on('addDir', (dirPath) => {
                console.log(chalk.green(`[Server Watcher] Directory added: ${dirPath}`));
                this.handleFileChange('addDir', dirPath);
            })
            .on('unlinkDir', (dirPath) => {
                console.log(chalk.red(`[Server Watcher] Directory deleted: ${dirPath}`));
                this.handleFileChange('unlinkDir', dirPath);
            })
            .on('error', (error) => {
                console.error(chalk.red('[Server Watcher] Error:'), error);
            });
    }
    
    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log(chalk.green(`[Socket.IO] Client connected: ${socket.id}`));
            this.clients.add(socket.id);
            
            this.sendFileSystemState(socket);
            
            socket.on('disconnect', () => {
                console.log(chalk.yellow(`[Socket.IO] Client disconnected: ${socket.id}`));
                this.clients.delete(socket.id);
            });
            
            socket.on('fileOperation', async (data) => {
                console.log(chalk.blue(`[Socket.IO] Received fileOperation from ${socket.id}:`), data);
                try {
                    await this.handleClientOperation(data);
                } catch (error) {
                    console.error(chalk.red(`[Socket.IO] Error handling fileOperation from ${socket.id}: ${error.message}`), error);
                    socket.emit('operationError', { message: error.message, operation: data.operation, path: data.path });
                }
            });

            socket.on('requestFileContent', async (data) => {
                const { path: filePath } = data;
                const fullPath = path.join(this.watchDir, filePath);
                console.log(chalk.blue(`[Socket.IO] Client ${socket.id} requested content for: ${filePath}`));
                try {
                    if (await fs.pathExists(fullPath) && (await fs.stat(fullPath)).isFile()) {
                        const content = await fs.readFile(fullPath);
                        socket.emit('fileContent', { path: filePath, content: content.toString('base64'), encoding: 'base64' });
                        console.log(chalk.green(`[Socket.IO] Sent content for ${filePath} to client ${socket.id}`));
                    } else {
                        console.log(chalk.yellow(`[Socket.IO] File not found or not a file on server for requestFileContent: ${fullPath}`));
                        socket.emit('operationError', { message: `File not found on server: ${filePath}`, operation: 'requestFileContent', path: filePath });
                    }
                } catch (error) {
                    console.error(chalk.red(`[Socket.IO] Error reading file content for ${filePath} (requestFileContent):`), error);
                    socket.emit('operationError', { message: `Error reading file ${filePath}`, operation: 'requestFileContent', path: filePath });
                }
            });
        });
    }
    
    async handleClientOperation(data) {
        const { operation, path: relativePath, content, newPath, mode } = data;
        const fullPath = path.join(this.watchDir, relativePath);
        console.log(chalk.blue(`[Server Op] Processing client operation: ${operation} on ${relativePath}`));
        try {
            switch (operation) {
                case 'write':
                    await fs.ensureDir(path.dirname(fullPath));
                    await fs.writeFile(fullPath, Buffer.from(content, 'base64'));
                    console.log(chalk.green(`[Server Op] File written: ${fullPath}`));
                    break;
                case 'delete':
                    await fs.remove(fullPath);
                    console.log(chalk.green(`[Server Op] Resource removed: ${fullPath}`));
                    break;
                case 'mkdir':
                    await fs.ensureDir(fullPath);
                    console.log(chalk.green(`[Server Op] Directory created: ${fullPath}`));
                    break;
                case 'rename':
                    const newFullPath = path.join(this.watchDir, newPath);
                    await fs.move(fullPath, newFullPath);
                    console.log(chalk.green(`[Server Op] Renamed: ${fullPath} -> ${newFullPath}`));
                    break;
                case 'chmod':
                    await fs.chmod(fullPath, mode);
                    console.log(chalk.green(`[Server Op] Chmod ${mode.toString(8)} applied to ${fullPath}`));
                    this.io.emit('fileSystemChange', { event: 'chmod', path: relativePath, mode });
                    break;
                default:
                    throw new Error(`Unknown client operation: ${operation}`);
            }
        } catch (error) {
            console.error(chalk.red(`[Server Op] Error performing ${operation} on ${relativePath}: ${error.message}`), error);
            throw error;
        }
    }
    
    async handleFileChange(event, watchedPath) {
        const relativePath = path.relative(this.watchDir, watchedPath);
        if (!relativePath && relativePath !== '') { // chokidar can sometimes emit for the root path itself with an empty relativePath
            console.log(chalk.yellow(`[Server Watcher] Ignoring event for root watch directory: ${event} on ${watchedPath}`));
            return;
        }
        console.log(chalk.blue(`[Server Watcher] Broadcasting FS change: ${event} - ${relativePath}`));
        
        const eventData = { event, path: relativePath };

        try {
            const fullPath = path.join(this.watchDir, relativePath);

            if (event === 'add' || event === 'change') {
                if (await fs.pathExists(fullPath) && (await fs.stat(fullPath)).isFile()) {
                    eventData.content = (await fs.readFile(fullPath)).toString('base64');
                    eventData.encoding = 'base64';
                    eventData.type = 'file';
                } else {
                    console.log(chalk.yellow(`[Server Watcher] File for ${event} at ${relativePath} not found or not a file when preparing broadcast. Sending event without content.`));
                    eventData.type = 'file'; // Assume it was a file
                }
            } else if (event === 'addDir') {
                eventData.type = 'directory';
            } else if (event === 'unlink') {
                eventData.type = 'file'; // Chokidar 'unlink' is for files
            } else if (event === 'unlinkDir') {
                eventData.type = 'directory'; // Chokidar 'unlinkDir' is for directories
            }
            
            console.log(chalk.magentaBright(`[Server Watcher] Emitting fileSystemChange:`), eventData);
            this.io.emit('fileSystemChange', eventData);

        } catch (error) {
            console.error(chalk.red(`[Server Watcher] Error preparing fileChange broadcast for ${relativePath}:`), error);
            this.io.emit('fileSystemChange', { event, path: relativePath, type: (event.includes('Dir') ? 'directory' : 'file') }); // Fallback
        }
    }
    
    async sendFileSystemState(socket) {
        console.log(chalk.blue(`[Socket.IO] Attempting to send file system state to ${socket.id}`));
        try {
            const files = await this.getFileSystemState();
            console.log(chalk.blue(`[Socket.IO] Found ${files.length} items in file system state for ${socket.id}`));
            socket.emit('fileSystemState', files);
        } catch (error) {
            console.error(chalk.red(`[Socket.IO] Error sending file system state to ${socket.id}:`), error);
            socket.emit('operationError', { message: 'Failed to retrieve file system state', operation: 'sendFileSystemState' });
        }
    }
    
    async getFileSystemState(currentPath = this.watchDir, relativeBasePath = '') {
        const items = [];
        try {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue; // Skip hidden files/dirs

                const entryRelativePath = path.join(relativeBasePath, entry.name);
                const entryAbsolutePath = path.join(currentPath, entry.name);
                
                if (entry.isDirectory()) {
                    items.push({ path: entryRelativePath, type: 'directory' });
                    const subItems = await this.getFileSystemState(entryAbsolutePath, entryRelativePath);
                    items.push(...subItems);
                } else if (entry.isFile()) {
                    const stats = await fs.stat(entryAbsolutePath);
                    items.push({
                        path: entryRelativePath,
                        type: 'file',
                        size: stats.size,
                        // modified: stats.mtime // Skipping for now to reduce complexity
                    });
                }
            }
        } catch (error) {
            console.error(chalk.red(`[FS] Error processing directory ${currentPath} for getFileSystemState:`), error);
        }
        return items;
    }
    
    start() {
        this.server.listen(this.port, () => {
            console.log(chalk.green(`Server running on port ${this.port}`));
            console.log(chalk.green(`Watching directory: ${this.watchDir}`));
        });
    }
}

program
    .option('-p, --port <number>', 'Server port', '3000')
    .option('-d, --dir <path>', 'Directory to watch', './shared')
    .parse(process.argv);

const options = program.opts();

const server = new FileSystemServer(parseInt(options.port), options.dir);
server.start();