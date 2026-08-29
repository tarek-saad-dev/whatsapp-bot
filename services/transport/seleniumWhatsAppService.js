require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { Builder, By, Key } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { createSendQueue } = require('../sendQueue');
const { groupWebUrlFromInviteLink, normalizeGroupName } = require('../groupTarget');
const { createInboxListener } = require('../inbox/inboxListener');
const {
    listPageTargets,
    waitForWhatsAppPageTarget,
    isDebugPortActive: isChromeDebugPortActive,
} = require('../chromeDebug');

// --- Fixed singleton configuration ---
const DEBUG_PORT = Number(process.env.WHATSAPP_DEBUG_PORT) || 9222;
const DEBUG_HOST = '127.0.0.1';
const DEBUG_ADDRESS = `${DEBUG_HOST}:${DEBUG_PORT}`;
const WHATSAPP_URL = process.env.WHATSAPP_WEB_URL || 'https://web.whatsapp.com';
const PROFILE_DIR = process.env.WHATSAPP_CHROME_PROFILE_DIR || path.join(__dirname, '..', '..', 'chrome-profile-automessage');
const PROFILE_NAME = process.env.WHATSAPP_CHROME_PROFILE_NAME || 'BotProfile';
const WA_DEBUG_FULL_PHONE = process.env.WHATSAPP_DEBUG_FULL_PHONE === 'true';

// --- Singleton state ---
let driver = null;
let initializationPromise = null;
let chromeProcess = null;

// --- Serial send queue (concurrency = 1) — shared Chrome page cannot send in parallel ---
const sendQueue = createSendQueue({ concurrency: 1 });

const inboxListener = createInboxListener({
    getDriver: () => driver,
    getOrCreateDriver,
    switchToWhatsAppTab,
    isReady,
    sendQueue,
});

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

function makeGroupMessageId(targetKey) {
  const safe = String(targetKey || 'group').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  return `wa-grp-${Date.now()}-${safe}-${Math.random().toString(36).slice(2, 8)}`;
}

const COMPOSE_SELECTORS = [
  'div[contenteditable="true"][data-tab="10"]',
  'div[contenteditable="true"][data-tab="1"]',
  'footer div[contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'div[aria-placeholder][contenteditable="true"]',
];

const SEARCH_SELECTORS = [
  'div[contenteditable="true"][data-tab="3"]',
  'div[title="Search input textbox"]',
  'div[role="textbox"][title*="Search"]',
  '[aria-label="Search input textbox"]',
];

const CONTACT_PICKER_SEARCH_SELECTORS = [
  'div[data-animate-modal-popup="true"] div[contenteditable="true"]',
  'div[role="dialog"] div[contenteditable="true"]',
  '[aria-label="Search name or number"]',
  '[aria-label="Type a name or phone number"]',
  'div[title="Search contacts"]',
  'div[title="Search name or number"]',
  'div[contenteditable="true"][data-tab="2"]',
  'div[contenteditable="true"][data-tab="3"]',
];

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
    return isChromeDebugPortActive(DEBUG_HOST, DEBUG_PORT, timeoutMs);
}

async function listWhatsAppPageTargets() {
    return listPageTargets({ host: DEBUG_HOST, port: DEBUG_PORT });
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
        const profileMarker = path.basename(PROFILE_DIR);
        const cmd = `wmic process where "name='chrome.exe' and CommandLine like '%${profileMarker}%'" get ProcessId /format:csv`;
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

            const waTarget = await waitForWhatsAppPageTarget({
                host: DEBUG_HOST,
                port: DEBUG_PORT,
                timeoutMs: 90000,
                pollMs: 1000,
            });
            if (!waTarget) {
                console.log('📱 No WhatsApp CDP page target yet — opening via Selenium after attach');
            } else {
                console.log(`✅ WhatsApp CDP page target: ${waTarget.id} (${waTarget.title})`);
            }

            const options = new chrome.Options();
            options.debuggerAddress(DEBUG_ADDRESS);

            const attachTimeoutMs = 45000;
            driver = await Promise.race([
                new Builder()
                    .forBrowser('chrome')
                    .setChromeOptions(options)
                    .build(),
                sleep(attachTimeoutMs).then(() => {
                    throw new Error(`Selenium attach timed out after ${attachTimeoutMs}ms`);
                }),
            ]);

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

async function findComposeBox(drv, timeoutMs = 60000, invalidCheck = null) {
    const composeStart = Date.now();
    while ((Date.now() - composeStart) < timeoutMs) {
        if (invalidCheck) {
            const invalid = await invalidCheck();
            if (invalid) return { invalid };
        }
        for (const sel of COMPOSE_SELECTORS) {
            try {
                const inputBox = await drv.findElement(By.css(sel));
                console.log(`📝 Compose box found with selector: ${sel}`);
                return { inputBox };
            } catch (_) { /* try next */ }
        }
        await sleep(1000);
    }
    return { error: 'Could not find compose box within timeout' };
}

async function submitComposeBox(drv, inputBox, message, { prefillOnly = false } = {}) {
    await sleep(2000);

    let box = inputBox;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await box.click();
            break;
        } catch (error) {
            const stale = String(error.message || '').includes('stale element');
            if (!stale || attempt === 2) throw error;
            const refound = await findComposeBox(drv, 10000);
            if (!refound.inputBox) throw error;
            box = refound.inputBox;
        }
    }

    await sleep(500);
    if (!prefillOnly && message) {
        await box.sendKeys(message);
        await sleep(300);
    }
    await box.sendKeys(Key.ENTER);
}

async function findSearchBox(drv) {
    for (const sel of SEARCH_SELECTORS) {
        try {
            return await drv.findElement(By.css(sel));
        } catch (_) { /* try next */ }
    }

    try {
        const icon = await drv.findElement(By.css('[data-icon="search"]'));
        await icon.click();
        await sleep(500);
        for (const sel of SEARCH_SELECTORS) {
            try {
                return await drv.findElement(By.css(sel));
            } catch (_) { /* try next */ }
        }
    } catch (_) {
        /* ignore */
    }

    return null;
}

async function findContactPickerSearch(drv, timeoutMs = 20000) {
    const start = Date.now();
    while ((Date.now() - start) < timeoutMs) {
        for (const sel of CONTACT_PICKER_SEARCH_SELECTORS) {
            try {
                const el = await drv.findElement(By.css(sel));
                return el;
            } catch (_) { /* try next */ }
        }

        try {
            const icon = await drv.findElement(By.css('[data-icon="search"]'));
            await icon.click();
            await sleep(400);
        } catch (_) {
            /* ignore */
        }

        await sleep(500);
    }
    return null;
}

async function openGroupByName(drv, groupName) {
    await drv.get(WHATSAPP_URL);
    await ensureWhatsAppReady();

    const searchBox = await findSearchBox(drv);
    if (!searchBox) {
        throw new Error('Could not find WhatsApp search box');
    }

    await searchBox.click();
    await sleep(300);
    await searchBox.sendKeys(Key.chord(Key.CONTROL, 'a'));
    await searchBox.sendKeys(Key.BACK_SPACE);
    await searchBox.sendKeys(groupName);
    await sleep(2000);

    const resultSelectors = [
        `#pane-side span[title="${groupName}"]`,
        `span[title="${groupName}"]`,
    ];

    for (const sel of resultSelectors) {
        try {
            const el = await drv.findElement(By.css(sel));
            await el.click();
            await sleep(1500);
            return;
        } catch (_) { /* try next */ }
    }

    try {
        const pageText = (await drv.getPageSource()).toLowerCase();
        if (
            pageText.includes('no chats, contacts or messages found') ||
            pageText.includes('لم يتم العثور على محادثات')
        ) {
            throw new Error(`Group not found: ${groupName}`);
        }
    } catch (error) {
        if (error.message.startsWith('Group not found:')) throw error;
    }

    try {
        const item = await drv.findElement(By.css('#pane-side div[role="listitem"]'));
        await item.click();
        await sleep(1500);
        return;
    } catch (_) {
        throw new Error(`Group not found: ${groupName}`);
    }
}

async function openGroupChat(drv, { groupInviteLink, groupName }) {
    if (groupInviteLink) {
        const url = groupWebUrlFromInviteLink(groupInviteLink);
        if (!url) {
            return {
                success: false,
                status: 'invalid_target',
                error: 'groupInviteLink is invalid',
            };
        }
        await drv.get(url);
        await sleep(2000);
        return {
            success: true,
            target: groupInviteLink,
            chatId: url,
        };
    }

    const normalizedName = normalizeGroupName(groupName);
    if (!normalizedName) {
        return {
            success: false,
            status: 'invalid_target',
            error: 'groupName is invalid',
        };
    }

    await openGroupByName(drv, normalizedName);
    return {
        success: true,
        target: normalizedName,
        chatId: `group:${normalizedName}`,
    };
}

async function detectGroupNotAccessible(drv) {
    try {
        const text = (await drv.getPageSource()).toLowerCase();
        if (
            text.includes('invite link is invalid') ||
            text.includes('رابط الدعوة غير صالح') ||
            text.includes('link you followed is invalid')
        ) {
            return 'group_not_accessible';
        }
    } catch (_) {
        /* ignore */
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

    const composeResult = await findComposeBox(drv, 60000, detectInvalidPhonePage);
    if (composeResult.invalid === 'not_registered') {
        console.log(`[whatsapp] not_registered phone=${maskPhone(formattedPhone)} chatId=${chatId}`);
        return {
            success: false,
            status: 'not_registered',
            error: 'Phone number is not registered on WhatsApp',
            phone: formattedPhone,
            chatId,
        };
    }
    if (!composeResult.inputBox) {
        throw new Error(composeResult.error || 'Could not find compose box within 60 seconds');
    }

    await submitComposeBox(drv, composeResult.inputBox, message, { prefillOnly: true });

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

async function sendGroupMessageInternal(target, message, meta = {}) {
    const drv = await getOrCreateDriver();
    await switchToWhatsAppTab();

    const logCtx = meta.logContext || {};
    const typePrefix = logCtx.type || 'group';
    const targetLabel = target.groupInviteLink
        ? `invite=${String(target.groupInviteLink).slice(0, 32)}...`
        : `groupName=${target.groupName}`;

    console.log(`[whatsapp] ${typePrefix} sending ${targetLabel}`);

    const opened = await openGroupChat(drv, target);
    if (!opened.success) {
        return {
            success: false,
            status: opened.status || 'invalid_target',
            error: opened.error || 'Invalid group target',
            target: target.groupInviteLink || target.groupName,
        };
    }

    await sleep(1500);
    const inaccessible = await detectGroupNotAccessible(drv);
    if (inaccessible === 'group_not_accessible') {
        console.log(`[whatsapp] group_not_accessible ${targetLabel}`);
        return {
            success: false,
            status: 'group_not_accessible',
            error: 'Group invite link is invalid or the bot is not a member of this group',
            target: opened.target,
            chatId: opened.chatId,
        };
    }

    const composeResult = await findComposeBox(drv, 60000, detectGroupNotAccessible);
    if (composeResult.invalid === 'group_not_accessible') {
        return {
            success: false,
            status: 'group_not_accessible',
            error: 'Group invite link is invalid or the bot is not a member of this group',
            target: opened.target,
            chatId: opened.chatId,
        };
    }
    if (!composeResult.inputBox) {
        throw new Error(composeResult.error || 'Could not find compose box within 60 seconds');
    }

    await submitComposeBox(drv, composeResult.inputBox, message, { prefillOnly: false });

    const messageId = makeGroupMessageId(opened.target);
    console.log(`[whatsapp] ${typePrefix} sent ${targetLabel} messageId=${messageId}`);

    const cfg = loadSettings();
    await sleep(getDelayMs(cfg));
    return {
        success: true,
        status: 'sent',
        messageId,
        target: opened.target,
        chatId: opened.chatId,
    };
}

/**
 * Awaited group send through the serial queue (concurrency = 1).
 */
async function sendGroupMessageAndWait(target, message, timeout = 120000, meta = {}) {
    const logCtx = meta.logContext || {};
    const typePrefix = logCtx.type || 'group';
    const targetLabel = target.groupInviteLink || target.groupName || 'unknown';
    console.log(`[whatsapp] ${typePrefix} queued target=${targetLabel}`);

    return sendQueue.enqueue(async () => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const result = await sendGroupMessageInternal(target, message, meta);
                if (result && (result.status === 'group_not_accessible' || result.status === 'invalid_target')) {
                    return result;
                }
                if (result && result.success) {
                    return result;
                }
                return {
                    success: false,
                    status: 'failed',
                    error: (result && result.error) || 'Group send failed',
                    target: target.groupInviteLink || target.groupName,
                };
            } catch (error) {
                if (error.message && error.message.includes('QR')) {
                    return {
                        success: false,
                        status: 'failed',
                        error: 'WhatsApp Web is not ready. Please scan the QR code and try again.',
                    };
                }
                if (error.message && error.message.startsWith('Group not found:')) {
                    return {
                        success: false,
                        status: 'group_not_found',
                        error: error.message,
                        target: target.groupName,
                    };
                }
                if (Date.now() - start >= timeout) {
                    return {
                        success: false,
                        status: 'failed',
                        error: error.message || 'Failed to send group message within timeout',
                    };
                }
                console.log(
                    `[whatsapp] group send retry target=${targetLabel} error=${error.message || error}`,
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

async function sendGroupMessage(target, message) {
    const readyNow = await isReady();
    if (readyNow) {
        sendQueue
            .enqueue(() => sendGroupMessageInternal(target, message))
            .catch((error) => {
                console.log(`⚠️ Group send failed for ${target.groupName || 'invite link'}:`, error.message);
            });
        return { success: true, message: 'Group message sending in background', status: 'queued' };
    }
    if (!initializationPromise) {
        getOrCreateDriver().catch((err) => console.error('❌ Failed to initialize driver:', err.message));
    }
    return {
        success: true,
        queued: true,
        status: 'queued',
        message: 'WhatsApp is not ready yet; initialize the session and retry',
    };
}

async function clickFirstMatching(drv, selectors) {
    for (const sel of selectors) {
        try {
            const el = await drv.findElement(By.css(sel));
            await el.click();
            return true;
        } catch (_) { /* try next */ }
    }
    return false;
}

async function createGroupInternal({ groupName, memberPhones = [] }) {
    const normalizedName = normalizeGroupName(groupName);
    if (!normalizedName) {
        return {
            success: false,
            status: 'invalid_target',
            error: 'groupName is invalid',
        };
    }

    const drv = await getOrCreateDriver();
    await switchToWhatsAppTab();
    await drv.get(WHATSAPP_URL);
    await ensureWhatsAppReady();

    const openedNewChat = await clickFirstMatching(drv, [
        '[data-icon="new-chat-outline"]',
        'button[aria-label="New chat"]',
        '[title="New chat"]',
    ]);
    if (!openedNewChat) {
        throw new Error('Could not find the New chat button');
    }
    await sleep(1000);

    let openedNewGroup = false;
    const newGroupSelectors = [
        'div[aria-label="New group"]',
        'div[title="New group"]',
    ];
    for (const sel of newGroupSelectors) {
        try {
            await drv.findElement(By.css(sel)).click();
            openedNewGroup = true;
            break;
        } catch (_) { /* try next */ }
    }
    if (!openedNewGroup) {
        try {
            const el = await drv.findElement(By.xpath("//*[contains(text(),'New group') or contains(text(),'مجموعة جديدة')]"));
            await el.click();
            openedNewGroup = true;
        } catch (_) {
            throw new Error('Could not find the New group option');
        }
    }
    await sleep(2500);

    const contactSearch = await findContactPickerSearch(drv);
    if (!contactSearch) {
        throw new Error('Could not find contact search while creating group');
    }

    for (const phone of memberPhones) {
        const formatted = formatPhoneNumber(phone);
        await contactSearch.click();
        await contactSearch.sendKeys(Key.chord(Key.CONTROL, 'a'));
        await contactSearch.sendKeys(Key.BACK_SPACE);
        await contactSearch.sendKeys(formatted);
        await sleep(2000);

        const contactSelectors = [
            `#pane-side span[title*="${formatted.slice(-4)}"]`,
            '#pane-side div[role="listitem"]',
        ];
        let picked = false;
        for (const sel of contactSelectors) {
            try {
                await drv.findElement(By.css(sel)).click();
                picked = true;
                break;
            } catch (_) { /* try next */ }
        }
        if (!picked) {
            throw new Error(`Could not add member with phone ${maskPhone(formatted)}`);
        }
        await sleep(800);
    }

    const advanced = await clickFirstMatching(drv, [
        '[data-icon="arrow-forward"]',
        '[data-icon="checkmark"]',
        'div[aria-label="Next"]',
    ]);
    if (!advanced) {
        throw new Error('Could not advance to group name step');
    }
    await sleep(1500);

    const subjectSelectors = [
        'div[contenteditable="true"][data-tab="10"]',
        'div[contenteditable="true"][data-tab="1"]',
        'div[role="textbox"][contenteditable="true"]',
    ];
    let subjectBox = null;
    for (const sel of subjectSelectors) {
        try {
            subjectBox = await drv.findElement(By.css(sel));
            break;
        } catch (_) { /* try next */ }
    }
    if (!subjectBox) {
        throw new Error('Could not find group name input');
    }

    await subjectBox.click();
    await subjectBox.sendKeys(normalizedName);
    await sleep(500);

    const created = await clickFirstMatching(drv, [
        '[data-icon="checkmark"]',
        'div[aria-label="Create group"]',
        'button[aria-label="Create group"]',
    ]);
    if (!created) {
        await subjectBox.sendKeys(Key.ENTER);
    }
    await sleep(3000);

    return {
        success: true,
        status: 'created',
        groupName: normalizedName,
        membersAdded: memberPhones.length,
    };
}

async function createGroupAndWait(options, timeout = 120000) {
    return sendQueue.enqueue(async () => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                return await createGroupInternal(options);
            } catch (error) {
                if (Date.now() - start >= timeout) {
                    return {
                        success: false,
                        status: 'failed',
                        error: error.message || 'Failed to create group within timeout',
                    };
                }
                console.log(`[whatsapp] create group retry error=${error.message || error}`);
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
    inboxListener.stop();
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
    const cdpWhatsAppPages = chromeConnected
        ? await listWhatsAppPageTargets()
        : [];
    const whatsappReady = await isReady();
    let whatsappTabFound = cdpWhatsAppPages.length > 0;
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
            whatsappTabFound = cdpWhatsAppPages.length > 0;
        }
    }
    return {
        success: true,
        transport: 'selenium',
        chromeConnected,
        whatsappReady,
        debugPort: DEBUG_PORT,
        profileDirectory: PROFILE_DIR,
        profileName: PROFILE_NAME,
        whatsappTabFound,
        seleniumDriverAttached: driver !== null,
        cdpWhatsAppPageCount: cdpWhatsAppPages.length,
        inbox: inboxListener.getStatus(),
    };
}

function formatPhoneNumber(phone) {
    return phone.toString().replace(/^0/, '20');
}

module.exports = {
    sendMessage,
    sendMessageAndWait,
    sendGroupMessage,
    sendGroupMessageAndWait,
    createGroupAndWait,
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
    listWhatsAppPageTargets,
    isDebugPortActive,
    getSendQueueStats,
    resetSendQueueStats,
    enqueueSendTask,
    maskPhone,
    chatIdFromPhone,
    normalizeForWhatsApp: formatPhoneNumber,
    startInboxListener: async (opts) => inboxListener.start(opts),
    stopInboxListener: () => inboxListener.stop(),
    getInbox: (limit) => inboxListener.getInbox(limit),
    pollInboxOnce: () => inboxListener.pollOnce(),
};
