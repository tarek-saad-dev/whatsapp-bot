/**
 * WhatsApp Bot Server Launcher
 * This file can be compiled to an .exe using pkg
 * 
 * Note: Due to Selenium WebDriver complexity, the batch file method
 * (start-server.bat) is recommended for most users.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');

console.log('========================================');
console.log('  WhatsApp Bot Server Launcher');
console.log('========================================\n');

// Change to the script directory
process.chdir(__dirname);

// Check if node_modules exists
if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
    console.log('⚠️  node_modules not found.');
    console.log('Please run: npm install');
    console.log('\nPress any key to exit...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 0));
    return;
}

console.log('🚀 Starting WhatsApp Bot Server...\n');
console.log('Server will be available at: http://localhost:3000\n');
console.log('Press Ctrl+C to stop the server\n');
console.log('========================================\n');

// Directly require and run the server
// This works better with pkg than spawning a child process
try {
    // Import server.js and start the server explicitly
    const { startServer } = require('./server.js');
    startServer().catch(error => {
        console.error('\n❌ Failed to start server:', error.message);
        console.error(error.stack);
        console.error('\nPress any key to exit...');
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', process.exit.bind(process, 1));
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\n🛑 Shutting down server...');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n\n🛑 Shutting down server...');
        process.exit(0);
    });
} catch (error) {
    console.error('\n❌ Failed to start server:', error.message);
    console.error(error.stack);
    console.error('\nPress any key to exit...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 1));
}
