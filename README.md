# Distributed File System

A real-time distributed file system implementation in Node.js that allows multiple clients to synchronize files and directories with a central server.

## Prerequisites

- Node.js (version 14 or higher)
- npm (Node Package Manager)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd distributed-file-system
```

2. Install dependencies:
```bash
npm install
```

## Running the System

### 1. Starting the Server

First, start the server in one terminal window:

```bash
# Start with default settings (port 3000, watching './shared' directory)
npm start

# Or with custom settings:
npm start -- --port 4000 --dir /path/to/shared
```

Server options:
- `-p, --port <number>`: Specify the server port (default: 3000)
- `-d, --dir <path>`: Specify the directory to watch (default: './shared')

### 2. Starting Clients

In separate terminal windows, start one or more clients:

```bash
# Start with default settings (connecting to localhost:3000, syncing with './local' directory)
npm run client

# Or with custom settings:
npm run client -- --server http://localhost:4000 --dir /path/to/local
```

Client options:
- `-s, --server <url>`: Specify the server URL (default: 'http://localhost:3000')
- `-d, --dir <path>`: Specify the local directory to sync (default: './local')

## Usage Examples

### Example 1: Basic Setup
```bash
# Terminal 1 - Start server
npm start

# Terminal 2 - Start client
npm run client
```

### Example 2: Custom Port and Directories
```bash
# Terminal 1 - Start server on port 4000
npm start -- --port 4000 --dir /Users/me/shared

# Terminal 2 - Start client connecting to custom server
npm run client -- --server http://localhost:4000 --dir /Users/me/local
```

### Example 3: Multiple Clients
```bash
# Terminal 1 - Start server
npm start

# Terminal 2 - Start first client
npm run client -- --dir /Users/me/local1

# Terminal 3 - Start second client
npm run client -- --dir /Users/me/local2
```

## File Operations

The system supports the following operations in real-time:

1. **Creating Files/Directories**
   - Create files or directories in any client's local directory
   - Changes are automatically synced to the server and other clients

2. **Modifying Files**
   - Edit files in any client's local directory
   - Changes are immediately propagated to all other clients

3. **Deleting Files/Directories**
   - Delete files or directories from any client
   - Deletions are synchronized across all clients

4. **Renaming Files/Directories**
   - Rename files or directories in any client
   - Renames are reflected across all clients

## Monitoring

- The server console shows:
  - Client connections/disconnections
  - File system changes
  - Error messages

- The client console shows:
  - Connection status
  - Synchronization status
  - File system changes
  - Error messages

## Troubleshooting

1. **Connection Issues**
   - Ensure the server is running before starting clients
   - Check if the port is available
   - Verify the server URL in client configuration

2. **File Sync Issues**
   - Check file permissions
   - Ensure sufficient disk space
   - Verify network connectivity

3. **Common Errors**
   - "Port already in use": Change the server port
   - "Cannot connect to server": Check server URL and port
   - "Permission denied": Check directory permissions

## Security Notes

- The system currently runs without authentication
- Recommended for use in trusted network environments
- For production use, implement proper authentication and encryption

## Directory Structure

```
distributed-file-system/
├── server/
│   └── index.js
├── client/
│   └── index.js
├── package.json
└── README.md
```

## Contributing

Feel free to submit issues and enhancement requests! 