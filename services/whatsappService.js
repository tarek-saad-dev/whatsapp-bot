require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { Builder, By, Key } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { createSendQueue } = require('./sendQueue');

// --- Fixed singleton configuration ---
const DEBUG_PORT = Number(process.env.WHATSAPP_DEBUG_PORT) || 9222;
const DEBUG_HOST = '127.0.0.1';
const DEBUG_ADDRESS = `${DEBUG_HOST}:${DEBUG_PORT}`;
const WHATSAPP_URL = process.env.WHATSAPP_WEB_URL || 'https://web.whatsapp.com';
const PROFILE_DIR = process.env.WHATSAPP_CHROME_PROFILE_DIR || path.join(__dirname, '..', 'chrome-profile-automessage');
const PROFILE_NAME = process.env.WHATSAPP_CHROME_PROFILE_NAME || 'BotProfile';
const WA_DEBUG_FULL_PHONE = process.env.WHATSAPP_DEBUG_FULL_PHONE === 'true';

// --- Singleton state ---
let driver = null;
let initializationPromise = null;
let chromeProcess = null;

// --- Serial send queue (concurrency = 1) — shared Chrome page cannot send in parallel ---
const sendQueue = createSendQueue({ concurrency: 1 });

// --- Legacy queue (kept for /api/sales/* compatibility) ---
const messageQueue = [];
let isProcessingQueue = false;
let queueProcessorInterval = null;

function maskPhone(phone) {
  const s = String(phone || '');
  if (WA_DEBUG_FULL_PHONE) return s;
  if (s.length <= 4) return '****';
  return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

function chatIdFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `${digits}@c.us`;
}

function makeMessageId(phone) {
  return `wa-${Date.now()}-${String(phone).replace(/\D/g, '').slice(-8)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadSettings() {
    return {
        chromePath: process.env.CHROME_PATH || '',
        defaultDelayMs: Number(process.env.DEFAULT_DELAY_MS || 4000),
        useRandomDelay: process.env.USE_RANDOM_DELAY === 'true',
        minDelayMs: Number(process.env.MIN_DELAY_MS || 1000),
        maxDelayMs: Number(process.env.MAX_DELAY_MS || 2000),
    };
}

function getDelayMs(cfg) {
    if (cfg.useRandomDelay && cfg.maxDelayMs > cfg.minDelayMs) {
        return cfg.minDelayMs + Math.floor(Math.random() * (cfg.maxDelayMs - cfg.minDelayMs + 1));
    }
    return cfg.defaultDelayMs;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveChromePath() {
    const cfg = loadSettings();
    if (cfg.chromePath && fs.existsSync(cfg.chromePath)) return cfg.chromePath;
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function isDebugPortActive(timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = http.get(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/version`, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function waitForDebugPort(timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isDebugPortActive(2000)) return true;
        await sleep(1000);
    }
    return false;
}

function findBotChromePids() {
    if (process.platform !== 'win32') return [];
    try {
        const { execSync } = require('child_process');
        const cmd = `wmic process where "name='chrome.exe' and CommandLine like '%\\\\chrome-profile-automessage\\%'" get ProcessId /format:csv`;
        const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        return output.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.toLowerCase().includes('node'))
            .map(line => {
                const parts = line.split(',');
                return parseInt(parts[parts.length - 1], 10);
            })
            .filter(pid => !isNaN(pid) && pid > 0);
    } catch (error) {
        return [];
    }
}

async function killBotChrome() {
    if (process.platform !== 'win32') return;
    const pids = findBotChromePids();
    if (pids.length === 0) {
        console.log('ℹ️  No bot-owned Chrome PIDs to kill');
        return;
    }
    const { execSync } = require('child_process');
    console.log(`🧹 Killing bot-owned Chrome PIDs: [${pids.join(', ')}]`);
    for (const pid of pids) {
        try {
            execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: 'ignore' });
        } catch (_) { /* already exited */ }
    }
    await sleep(2000);
}

function launchChrome() {
    const chromePath = resolveChromePath();
    if (!chromePath) {
        throw new Error('Chrome executable not found. Please set CHROME_PATH or install Chrome.');
    }
    if (!fs.existsSync(PROFILE_DIR)) {
        fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        `--profile-directory=${PROFILE_NAME}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-notifications',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--start-maximized',
        '--disable-viz-display-compositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        WHATSAPP_URL,
    ];
    console.log(`🚀 Launching dedicated Chrome: ${chromePath}`);
    console.log(`   Profile: ${PROFILE_DIR}\\${PROFILE_NAME}`);
    console.log(`   Debug port: ${DEBUG_PORT}`);
    const proc = spawn(chromePath, args, { detached: false, windowsHide: false });
    chromeProcess = proc;
    proc.on('exit', (code) => {
        console.log(`⚠️  Dedicated Chrome process exited (code ${code || 'unknown'})`);
        chromeProcess = null;
        driver = null;
    });
    return proc;
}

async function findOrCreateWhatsAppTab() {
    const handles = await driver.getAllWindowHandles();
    for (const handle of handles) {
        await driver.switchTo().window(handle);
        const url = await driver.getCurrentUrl();
        if (url.includes('web.whatsapp.com')) {
            console.log(`✅ Reusing existing WhatsApp tab: ${handle}`);
            return handle;
        }
    }
    console.log('📱 Opening new WhatsApp Web tab');
    await driver.get(WHATSAPP_URL);
    return await driver.getWindowHandle();
}

async function ensureWhatsAppReady() {
    const selectors = [
        '#side',
        'div[role="textbox"]',
        'div[contenteditable="true"][data-tab="3"]',
        'div[contenteditable="true"][data-tab="10"]',
        'div[aria-label][contenteditable="true"]',
        'header span[title]',
        'div#main',
    ];
    const start = Date.now();
    while (Date.now() - start < 120000) {
        for (const sel of selectors) {
            try {
                await driver.findElement(By.css(sel));
                return true;
            } catch (_) { /* try next */ }
        }
        await sleep(2000);
    }
    return false;
}

async function getOrCreateDriver() {
    if (driver) {
        try {
            await driver.getTitle();
            return driver;
        } catch (e) {
            console.log('⚠️  Cached driver is dead, reconnecting...');
            driver = null;
        }
    }

    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = (async () => {
        try {
            const portActive = await isDebugPortActive();
            if (!portActive) {
                launchChrome();
                const portReady = await waitForDebugPort(120000);
                if (!portReady) {
                    throw new Error('Chrome debug port did not become active. Ensure Chrome can open in this session.');
                }
            } else {
                console.log(`🔌 Attaching to existing Chrome on port ${DEBUG_PORT}`);
            }

            const options = new chrome.Options();
            options.debuggerAddress(DEBUG_ADDRESS);

            driver = await new Builder()
                .forBrowser('chrome')
                .setChromeOptions(options)
                .build();

            await findOrCreateWhatsAppTab();
            const ready = await ensureWhatsAppReady();
            if (!ready) {
                throw new Error('WhatsApp Web did not become ready within 120 seconds. Please scan the QR code and try again.');
            }
            console.log('✅ WhatsApp Web is ready');
            return driver;
        } catch (error) {
            driver = null;
            throw error;
        } finally {
            initializationPromise = null;
        }
    })();

    return initializationPromise;
}

async function initializeDriver(waitForReady = false) {
    const drv = await getOrCreateDriver();
    if (waitForReady) {
        await ensureWhatsAppReady();
    }
    return drv;
}

async function isReady() {
    if (!driver) return false;
    try {
        const selectors = ['#side', 'div[role="textbox"]', 'div[aria-label][contenteditable="true"]', 'header span[title]'];
        for (const sel of selectors) {
            try {
                await driver.findElement(By.css(sel));
                return true;
            } catch (_) { /* try next */ }
        }
        return false;
    } catch (error) {
        return false;
    }
}

async function switchToWhatsAppTab() {
    if (!driver) return false;
    const handles = await driver.getAllWindowHandles();
    for (const handle of handles) {
        await driver.switchTo().window(handle);
        const url = await driver.getCurrentUrl();
        if (url.includes('web.whatsapp.com')) {
            return true;
        }
    }
    await driver.get(WHATSAPP_URL);
    await ensureWhatsAppReady();
    return true;
}

async function detectInvalidPhonePage(drv) {
    try {
        const text = (await drv.getPageSource()).toLowerCase();
        if (
            text.includes('phone number shared via url is invalid') ||
            text.includes('رقم الهاتف الذي تمت مشاركته عبر الرابط غير صالح') ||
            text.includes('invalid phone number')
        ) {
            return 'not_registered';
        }
    } catch (_) {
        /* ignore probe errors */
    }
    return null;
}

async function sendMessageInternal(phone, message, meta = {}) {
    const drv = await getOrCreateDriver();
    await switchToWhatsAppTab();

    const formattedPhone = formatPhoneNumber(phone);
    const chatId = chatIdFromPhone(formattedPhone);
    const logCtx = meta.logContext || {};
    const encodedMsg = encodeURIComponent(message);
    const url = `https://web.whatsapp.com/send?phone=${formattedPhone}&text=${encodedMsg}`;

    const typePrefix = logCtx.type || 'message';
    console.log(
        `[whatsapp] ${typePrefix} sending` +
            (logCtx.invoice ? ` invoice=${logCtx.invoice}` : '') +
            (logCtx.empId != null ? ` empId=${logCtx.empId}` : '') +
            ` phone=${maskPhone(formattedPhone)} chatId=${chatId}`,
    );
    await drv.get(url);

    // Give WA a moment to show invalid-number overlay if applicable
    await sleep(1500);
    const invalid = await detectInvalidPhonePage(drv);
    if (invalid === 'not_registered') {
        console.log(`[whatsapp] not_registered phone=${maskPhone(formattedPhone)} chatId=${chatId}`);
        return {
            success: false,
            status: 'not_registered',
            error: 'Phone number is not registered on WhatsApp',
            phone: formattedPhone,
            chatId,
        };
    }

    const composeSelectors = [
        'div[contenteditable="true"][data-tab="10"]',
        'div[contenteditable="true"][data-tab="1"]',
        'footer div[contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        'div[aria-placeholder][contenteditable="true"]',
    ];

    let inputBox = null;
    const composeStart = Date.now();
    while (!inputBox && (Date.now() - composeStart) < 60000) {
        const midInvalid = await detectInvalidPhonePage(drv);
        if (midInvalid === 'not_registered') {
            console.log(`[whatsapp] not_registered phone=${maskPhone(formattedPhone)} chatId=${chatId}`);
            return {
                success: false,
                status: 'not_registered',
                error: 'Phone number is not registered on WhatsApp',
                phone: formattedPhone,
                chatId,
            };
        }
        for (const sel of composeSelectors) {
            try {
                inputBox = await drv.findElement(By.css(sel));
                console.log(`📝 Compose box found with selector: ${sel}`);
                break;
            } catch (_) { /* try next */ }
        }
        if (!inputBox) await sleep(1000);
    }

    if (!inputBox) {
        throw new Error('Could not find compose box within 60 seconds');
    }

    await sleep(2000);
    await inputBox.click();
    await sleep(500);
    await inputBox.sendKeys(Key.ENTER);

    const messageId = makeMessageId(formattedPhone);
    console.log(
        `[whatsapp] ${typePrefix} sent` +
            (logCtx.invoice ? ` invoice=${logCtx.invoice}` : '') +
            (logCtx.empId != null ? ` empId=${logCtx.empId}` : '') +
            ` phone=${maskPhone(formattedPhone)} messageId=${messageId}`,
    );

    const cfg = loadSettings();
    await sleep(getDelayMs(cfg));
    return {
        success: true,
        status: 'sent',
        messageId,
        phone: formattedPhone,
        chatId,
    };
}

/**
 * Awaited send through the serial queue (concurrency = 1).
 * Concurrent HTTP callers still serialize on the shared Chrome page.
 */
async function sendMessageAndWait(phone, message, timeout = 120000, meta = {}) {
    const logCtx = meta.logContext || {};
    const typePrefix = logCtx.type || 'message';
    console.log(
        `[whatsapp] ${typePrefix} queued` +
            (logCtx.invoice ? ` invoice=${logCtx.invoice}` : '') +
            (logCtx.empId != null ? ` empId=${logCtx.empId}` : '') +
            ` phone=${maskPhone(phone)}`,
    );

    return sendQueue.enqueue(async () => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const result = await sendMessageInternal(phone, message, meta);
                if (result && result.status === 'not_registered') {
                    return result;
                }
                if (result && result.success) {
                    return result;
                }
                return {
                    success: false,
                    status: 'failed',
                    error: (result && result.error) || 'Send failed',
                    phone: formatPhoneNumber(phone),
                };
            } catch (error) {
                if (error.message && error.message.includes('QR')) {
                    return {
                        success: false,
                        status: 'failed',
                        error: 'WhatsApp Web is not ready. Please scan the QR code and try again.',
                    };
                }
                if (Date.now() - start >= timeout) {
                    return {
                        success: false,
                        status: 'failed',
                        error: error.message || 'Failed to send message within timeout',
                    };
                }
                console.log(
                    `[whatsapp] send retry phone=${maskPhone(phone)} error=${error.message || error}`,
                );
                await sleep(2000);
            }
        }
        return {
            success: false,
            status: 'failed',
            error: 'WhatsApp Web is not ready. Please scan the QR code and try again.',
        };
    });
}

async function sendMessage(phone, message) {
    // Legacy fire-and-forget still goes through the same serial queue.
    const readyNow = await isReady();
    if (readyNow) {
        sendQueue
            .enqueue(() => sendMessageInternal(phone, message))
            .catch((error) => {
                console.log(`⚠️ Send failed, queued message for ${maskPhone(phone)}:`, error.message);
                messageQueue.push({ phone, message });
                setTimeout(() => processMessageQueue(), 1000);
            });
        return { success: true, message: 'Message sending in background', status: 'queued' };
    }
    messageQueue.push({ phone, message });
    if (!initializationPromise) {
        getOrCreateDriver().catch((err) => console.error('❌ Failed to initialize driver:', err.message));
    }
    startQueueProcessor();
    return { success: true, queued: true, status: 'queued', message: 'Message queued, will be sent when WhatsApp is ready' };
}

function startQueueProcessor() {
    if (queueProcessorInterval) return;
    queueProcessorInterval = setInterval(() => {
        if (driver && messageQueue.length > 0) {
            processMessageQueue();
        }
    }, 3000);
}

function processMessageQueue() {
    if (isProcessingQueue || messageQueue.length === 0 || !driver) return;
    isProcessingQueue = true;
    const item = messageQueue.shift();
    // Route legacy backlog through the serial send queue too.
    sendQueue
        .enqueue(() => sendMessageInternal(item.phone, item.message))
        .then(() => {
            console.log(`✅ Queued message sent to ${maskPhone(item.phone)}`);
        })
        .catch((error) => {
            console.error(`❌ Failed to send queued message to ${maskPhone(item.phone)}:`, error.message);
        })
        .finally(() => {
            isProcessingQueue = false;
            if (messageQueue.length > 0) processMessageQueue();
        });
}

function getQueueInfo() {
    const stats = sendQueue.getStats();
    return {
        length: messageQueue.length,
        isProcessing: isProcessingQueue || stats.active > 0,
        driverInitialized: driver !== null,
        sendQueue: stats,
        messages: messageQueue.map((m) => ({ phone: maskPhone(m.phone) })),
    };
}

function getSendQueueStats() {
    return sendQueue.getStats();
}

function resetSendQueueStats() {
    sendQueue.resetStats();
}

/** Test-only: run an arbitrary task through the serial send queue. */
function enqueueSendTask(task) {
    return sendQueue.enqueue(task);
}

function processQueue() {
    console.log('🔧 Manual queue processing triggered');
    processMessageQueue();
}

async function reinitialize() {
    if (driver) {
        try { await driver.quit(); } catch (_) {}
        driver = null;
    }
    await killBotChrome();
    await sleep(1000);
    return getOrCreateDriver();
}

async function closeDriver() {
    if (driver) {
        try { await driver.quit(); } catch (error) { console.error('Error closing driver:', error.message); }
        driver = null;
    }
    if (chromeProcess) {
        try { chromeProcess.kill(); } catch (_) {}
        chromeProcess = null;
    }
}

function cleanup() {
    console.log('🧹 Cleaning up WhatsApp service state (profile preserved)...');
    if (driver) {
        try { driver.quit().catch(() => {}); } catch (_) {}
        driver = null;
    }
    chromeProcess = null;
    console.log('✅ Cleanup complete. Dedicated Chrome profile was preserved.');
}

function resetWhatsAppSession() {
    console.warn('⚠️  Resetting WhatsApp session. This will log you out and delete the dedicated profile.');
    if (driver) {
        try { driver.quit().catch(() => {}); } catch (_) {}
        driver = null;
    }
    chromeProcess = null;
    killBotChrome();
    try {
        if (fs.existsSync(PROFILE_DIR)) {
            fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
            console.log('✅ Dedicated profile directory removed');
        }
    } catch (error) {
        console.error('⚠️  Error removing profile directory:', error.message);
    }
}

async function getStatus() {
    const chromeConnected = await isDebugPortActive(3000);
    const whatsappReady = await isReady();
    let whatsappTabFound = false;
    if (driver) {
        try {
            const handles = await driver.getAllWindowHandles();
            for (const handle of handles) {
                await driver.switchTo().window(handle);
                const url = await driver.getCurrentUrl();
                if (url.includes('web.whatsapp.com')) {
                    whatsappTabFound = true;
                    break;
                }
            }
        } catch (_) {
            whatsappTabFound = false;
        }
    }
    return {
        success: true,
        chromeConnected,
        whatsappReady,
        debugPort: DEBUG_PORT,
        profileDirectory: PROFILE_DIR,
        profileName: PROFILE_NAME,
        whatsappTabFound,
    };
}

function formatPhoneNumber(phone) {
    return phone.toString().replace(/^0/, '20');
}

module.exports = {
    sendMessage,
    sendMessageAndWait,
    initializeDriver,
    isReady,
    reinitialize,
    closeDriver,
    getQueueInfo,
    processQueue,
    cleanup,
    resetWhatsAppSession,
    getStatus,
    formatPhoneNumber,
    getOrCreateDriver,
    getSendQueueStats,
    resetSendQueueStats,
    enqueueSendTask,
    maskPhone,
    chatIdFromPhone,
    normalizeForWhatsApp: formatPhoneNumber,
};
