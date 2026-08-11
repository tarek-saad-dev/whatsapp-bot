require('dotenv').config();

const { execSync } = require('child_process');
const express = require('express');
const path = require('path');
const campaignsRouter = require('./routes/campaigns');
const customersRouter = require('./routes/customers');
const salesRouter = require('./routes/sales');
const offersRouter = require('./routes/offers');
const templatesRouter = require('./routes/templates');
const whatsappRouter = require('./routes/whatsapp');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/campaigns', campaignsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/sales', salesRouter);
app.use('/api/offers', offersRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/admin/whatsapp', whatsappRouter);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Lazy-load services so tests can import app without triggering side effects
const whatsappService = require('./services/whatsappService');
const campaignWorker = require('./services/campaignWorker');

function freePort(port) {
    console.log(`Cleaning port ${port}...`);

    try {
        if (process.platform === 'win32') {
            let output = '';

            try {
                output = execSync(`netstat -ano -p tcp | findstr :${port}`, {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
            } catch {
                console.log(`Port ${port} is already free`);
                return;
            }

            const lines = output
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean);

            const pids = new Set();

            for (const line of lines) {
                const parts = line.split(/\s+/);

                // Example:
                // TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 12345
                const localAddress = parts[1];
                const state = parts[3];
                const pid = parts[4];

                const isExactPort =
                    localAddress?.endsWith(`:${port}`) ||
                    localAddress?.endsWith(`]:${port}`);

                if (isExactPort && state === 'LISTENING' && pid && Number(pid) !== process.pid) {
                    pids.add(pid);
                }
            }

            if (pids.size === 0) {
                console.log(`Port ${port} is already free`);
                return;
            }

            for (const pid of pids) {
                try {
                    execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
                    console.log(`Killed process ${pid} using port ${port}`);
                } catch (err) {
                    console.warn(`Could not kill process ${pid}:`, err.message);
                }
            }

            console.log(`Port ${port} is free`);
            return;
        }

        // macOS / Linux fallback
        let output = '';

        try {
            output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch {
            console.log(`Port ${port} is already free`);
            return;
        }

        const pids = output
            .split(/\r?\n/)
            .map(pid => pid.trim())
            .filter(pid => pid && Number(pid) !== process.pid);

        for (const pid of pids) {
            execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
            console.log(`Killed process ${pid} using port ${port}`);
        }

        console.log(`Port ${port} is free`);
    } catch (err) {
        console.warn(`Port cleanup warning: ${err.message}`);
    }
}

function listen() {
    return new Promise((resolve, reject) => {
        const server = app.listen(PORT, () => {
            console.log(`🚀 Campaign Management Server running on http://localhost:${PORT}`);
            console.log(`📱 Open your browser and navigate to http://localhost:${PORT}`);
            console.log(`🔔 Auto-message endpoint: http://localhost:${PORT}/api/sales/notify`);
            console.log(`📤 Local send endpoint: http://localhost:${PORT}/api/whatsapp/send`);
            console.log(`\n💡 On first run, scan the QR code when Chrome opens for WhatsApp Web`);
            console.log(`\n⚠️  IMPORTANT: Chrome requires an interactive Windows session to open.`);
            console.log(`   If Chrome doesn't open, ensure you're running: node server.js`);
            console.log(`   (not as a Windows Service or non-interactive session)`);
            console.log(`   See RUNNING_INSTRUCTIONS.md for details.\n`);
            resolve(server);
        });

        server.once('error', reject);
    });
}

/**
 * Start the Express server and campaign worker.
 * This is called by `node server.js` and by launcher.js. Tests import `app`
 * without calling this function, so workers and HTTP listeners stay disabled.
 */
async function startServer() {
    console.log('Starting WhatsApp Bot Server...');
    console.log('💡 WhatsApp service will initialize automatically when first message is received');

    // The campaign worker is intentionally not started for the local send endpoint.
    // Campaign execution is handled separately when needed.
    if (process.env.ENABLE_CAMPAIGN_WORKER === 'true') {
        campaignWorker.startWorker();
        console.log('💡 Campaign worker started - will process pending messages automatically');
    }

    freePort(PORT);

    try {
        return await listen();
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            console.warn(`Port ${PORT} still in use. Retrying cleanup...`);
            freePort(PORT);
            return await listen();
        }

        throw err;
    }
}

// Start the server only when this file is the entry point
if (require.main === module) {
    startServer().catch(err => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
}

module.exports = { app, startServer };
