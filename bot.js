require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const xlsx = require('xlsx');

function loadSettings() {
    return {
        keepLogin: process.env.KEEP_LOGIN === 'true',
        useDefaultChrome: process.env.USE_DEFAULT_CHROME === 'true',
        chromePath: process.env.CHROME_PATH || '',
        defaultDelayMs: Number(process.env.DEFAULT_DELAY_MS || 4000),
        useRandomDelay: process.env.USE_RANDOM_DELAY === 'true',
        minDelayMs: Number(process.env.MIN_DELAY_MS || 1000),
        maxDelayMs: Number(process.env.MAX_DELAY_MS || 2000),
        excelFile: process.env.EXCEL_FILE || 'contacts.xlsx',
        excelSheet: process.env.EXCEL_SHEET || 'BOT',
    };
}

function getDelayMs(cfg) {
    if (cfg.useRandomDelay && cfg.maxDelayMs > cfg.minDelayMs) {
        const diff = cfg.maxDelayMs - cfg.minDelayMs;
        return cfg.minDelayMs + Math.floor(Math.random() * (diff + 1));
    }
    return cfg.defaultDelayMs;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadContacts(cfg) {
    const workbook = xlsx.readFile(cfg.excelFile);
    const sheet = workbook.Sheets[cfg.excelSheet];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    const contacts = [];
    for (let i = 1; i < rows.length; i++) { // skip header
        const row = rows[i];
        const phone = row[0];
        const message = row[1];
        if (phone && message) {
            contacts.push({ phone: String(phone), message: String(message) });
        }
    }
    return contacts;
}

async function createDriver(cfg) {
    const options = new chrome.Options();

    // Always use a dedicated profile directory so the bot NEVER touches the user's Chrome
    const profileDir = path.join(__dirname, 'chrome-profile');
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    options.addArguments(`--user-data-dir=${profileDir}`);
    options.addArguments('--profile-directory=BotProfile');
    console.log(` Isolated Chrome profile: ${profileDir} (sub-profile: BotProfile)`);

    // custom chrome binary (لو محتاج)
    if (!cfg.useDefaultChrome && cfg.chromePath) {
        options.setChromeBinaryPath(cfg.chromePath);
    }

    options.addArguments('--disable-notifications');
    options.addArguments('--no-sandbox');
    options.addArguments('--disable-dev-shm-usage');

    // Unique debugging port to avoid conflicts with other Chrome instances
    const randomPort = 9422 + Math.floor(Math.random() * 100);
    options.addArguments(`--remote-debugging-port=${randomPort}`);
    console.log(`   Debug port: ${randomPort}`);

    const driver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .build();

    console.log(' Bot Chrome launched — user Chrome windows are safe');
    return driver;
}

async function openWhatsApp(driver) {
    await driver.get('https://web.whatsapp.com');

    console.log('Please scan the QR code if required...');
    // Try multiple QR selectors
    const qrSelectors = ['canvas[aria-label="Scan me!"]', 'div[data-ref]', 'canvas'];
    for (const sel of qrSelectors) {
        try {
            await driver.wait(until.elementLocated(By.css(sel)), 5000);
            console.log(`QR element found (${sel})`);
            break;
        } catch (_) { /* try next */ }
    }

    // Wait for WhatsApp to be ready using multiple selectors
    const readySelectors = [
        '#side',
        'div[role="textbox"]',
        'div[contenteditable="true"][data-tab="3"]',
        'div[contenteditable="true"][data-tab="10"]',
        'div[aria-label][contenteditable="true"]',
        'header span[title]',
        'div#main',
    ];
    const readyStart = Date.now();
    let ready = false;
    while (!ready && (Date.now() - readyStart) < 120000) {
        for (const sel of readySelectors) {
            try {
                await driver.findElement(By.css(sel));
                ready = true;
                break;
            } catch (_) { /* not found yet */ }
        }
        if (!ready) await sleep(2000);
    }
    if (!ready) throw new Error('WhatsApp Web did not become ready within 120s');
    console.log('WhatsApp Web is ready.');
}

async function sendMessageToContact(driver, cfg, contact) {
    const { phone, message } = contact;

    // رقم لازم يكون دولي
    const formattedPhone = phone.toString().replace(/^0/, "20");

    const encodedMsg = encodeURIComponent(message);

    // استخدم WhatsApp Web مباشرة
    const url = `https://web.whatsapp.com/send?phone=${formattedPhone}`;

    console.log(`Opening chat for ${formattedPhone} ...`);
    await driver.get(url);

    // انتظار لحد ما بوكس الكتابة يظهر
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
        for (const sel of composeSelectors) {
            try {
                inputBox = await driver.findElement(By.css(sel));
                break;
            } catch (_) { /* try next */ }
        }
        if (!inputBox) await sleep(1000);
    }
    if (!inputBox) throw new Error('Compose box not found within 60s');

    // كتابة الرسالة + إرسال
    // Send message with proper line break handling
    // Split by newlines and use Shift+Enter for line breaks (not regular Enter)
    await inputBox.sendKeys(Key.END);
    
    // Split message into lines and send each line with Shift+Enter for line breaks
    const lines = message.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line) {
            // Send the line text
            await inputBox.sendKeys(line);
        }
        
        // If not the last line, add a line break (Shift+Enter)
        // If it's the last line, we'll add Enter at the end to send
        if (i < lines.length - 1) {
            await inputBox.sendKeys(Key.SHIFT, Key.ENTER);
        }
    }
    
    // Send the complete message with Enter
    await inputBox.sendKeys(Key.ENTER);

    const delay = getDelayMs(cfg);
    console.log(`Message sent to ${formattedPhone}. Waiting ${delay} ms...`);
    await sleep(delay);
}


async function main() {
    const cfg = loadSettings();
    const contacts = loadContacts(cfg);

    console.log(`Loaded ${contacts.length} contacts.`);

    const driver = await createDriver(cfg);

    try {
        await openWhatsApp(driver);

        for (let i = 0; i < contacts.length; i++) {
            const c = contacts[i];
            try {
                await sendMessageToContact(driver, cfg, c);
            } catch (err) {
                console.error(`Error sending to ${c.phone}:`, err.message);
            }
        }

        console.log('Done sending all messages.');
    } catch (err) {
        console.error('Fatal error:', err);
    } finally {
        // سيب المتصفح مفتوح لو حابب
        // لو عاوز تقفله:
        // await driver.quit();
    }
}

main();