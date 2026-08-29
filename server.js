require('dotenv').config();

const { execSync } = require('child_process');
const express = require('express');
const whatsappRouter = require('./routes/whatsapp');
const whatsappService = require('./services/whatsappService');
const { isBaileysTransport } = require('./services/transport/config');

const app = express();

function getPort() {
    return Number(process.env.PORT || 3000);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/whatsapp', whatsappRouter);

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
    const PORT = getPort();
    return new Promise((resolve, reject) => {
        const server = app.listen(PORT, () => {
            console.log(`WhatsApp Messaging Gateway running on http://localhost:${PORT}`);
            console.log(`Health:  http://localhost:${PORT}/api/health`);
            console.log(`Send:    http://localhost:${PORT}/api/whatsapp/send`);
            console.log(`Group:   http://localhost:${PORT}/api/whatsapp/send-group`);
            console.log(`Status:  http://localhost:${PORT}/api/whatsapp/status`);
            console.log(`Inbox:   http://localhost:${PORT}/api/whatsapp/inbox`);
            if (isBaileysTransport()) {
                console.log(`\nTransport: Baileys (no Chrome). Scan QR in terminal if prompted.\n`);
            } else {
                console.log(`\nOn first run, scan the QR code when Chrome opens for WhatsApp Web.`);
                console.log(`Chrome requires an interactive Windows session to open.\n`);
            }
            resolve(server);
        });

        server.once('error', reject);
    });
}

/**
 * Start the Express gateway. Tests import `app` without calling this function.
 */
async function startServer() {
    console.log('Starting WhatsApp Messaging Gateway...');
    console.log('WhatsApp service will initialize automatically when the first message is sent.');

    const inboxListen = process.env.WHATSAPP_INBOX_LISTEN === 'true';
    if (inboxListen) {
        if (isBaileysTransport()) {
            console.log('Inbox listener enabled — Baileys event transport (no Chrome/DOM).');
            whatsappService.startInboxListener({ initDriver: false }).catch((err) => {
                console.error('Failed to start Baileys inbox transport:', err.message);
            });
        } else {
            console.log('Inbox listener enabled — Chrome will open so the bot can read new incoming messages.');
            whatsappService.startInboxListener({ initDriver: true }).catch((err) => {
                console.error('Failed to start inbox listener:', err.message);
            });
        }
    } else {
        console.log('Inbox listener is off. POST /api/whatsapp/inbox/start or set WHATSAPP_INBOX_LISTEN=true.');
    }

    freePort(getPort());

    try {
        return await listen();
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            console.warn(`Port ${getPort()} still in use. Retrying cleanup...`);
            freePort(getPort());
            return await listen();
        }

        throw err;
    }
}

if (require.main === module) {
    startServer().catch(err => {
        console.error('Failed to start gateway:', err);
        process.exit(1);
    });
}

module.exports = { app, startServer };
