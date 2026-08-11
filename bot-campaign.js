require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const campaignExecutor = require('./services/campaignExecutor');

function loadSettings() {
    return {
        keepLogin: process.env.KEEP_LOGIN === 'true',
        useDefaultChrome: process.env.USE_DEFAULT_CHROME === 'true',
        chromePath: process.env.CHROME_PATH || '',
        defaultDelayMs: Number(process.env.DEFAULT_DELAY_MS || 4000),
        useRandomDelay: process.env.USE_RANDOM_DELAY === 'true',
        minDelayMs: Number(process.env.MIN_DELAY_MS || 1000),
        maxDelayMs: Number(process.env.MAX_DELAY_MS || 2000),
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

async function createDriver(cfg) {
    const options = new chrome.Options();

    // Fully isolated profile for campaigns — never touches user's Chrome
    const campaignProfileDir = path.join(__dirname, 'chrome-profile-campaign');
    if (!fs.existsSync(campaignProfileDir)) {
        fs.mkdirSync(campaignProfileDir, { recursive: true });
    }
    options.addArguments(`--user-data-dir=${campaignProfileDir}`);
    options.addArguments('--profile-directory=CampaignBotProfile');
    console.log(`🔒 Isolated Chrome profile: ${campaignProfileDir} (sub-profile: CampaignBotProfile)`);

    // custom chrome binary
    if (!cfg.useDefaultChrome && cfg.chromePath) {
        options.setChromeBinaryPath(cfg.chromePath);
    }

    // Chrome stability options
    options.addArguments('--disable-notifications');
    options.addArguments('--no-sandbox');
    options.addArguments('--disable-dev-shm-usage');
    options.addArguments('--disable-gpu');
    
    // Unique debugging port to avoid conflicts with other Chrome instances
    const randomPort = 9522 + Math.floor(Math.random() * 100);
    options.addArguments(`--remote-debugging-port=${randomPort}`);
    console.log(`   Debug port: ${randomPort}`);
    
    try {
        const driver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(options)
            .build();
        console.log('🔒 Campaign Chrome launched — user Chrome windows are safe');
        return driver;
    } catch (error) {
        console.error('\n❌ Failed to start Chrome. Common solutions:');
        console.error('   1. Make sure no other bot instance is using the same profile');
        console.error('   2. Check if ChromeDriver version matches your Chrome version');
        console.error('   3. Ensure Node.js is running in an interactive session\n');
        throw error;
    }
}

async function openWhatsApp(driver) {
    await driver.get('https://web.whatsapp.com');

    console.log('Please scan the QR code if required...');
    const qrSelectors = ['canvas[aria-label="Scan me!"]', 'div[data-ref]', 'canvas'];
    for (const sel of qrSelectors) {
        try {
            await driver.wait(until.elementLocated(By.css(sel)), 5000);
            console.log(`QR element found (${sel})`);
            break;
        } catch (_) { /* try next */ }
    }

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

    // Format phone number (international format)
    const formattedPhone = phone.toString().replace(/^0/, "20");

    const encodedMsg = encodeURIComponent(message);

    const url = `https://web.whatsapp.com/send?phone=${formattedPhone}`;

    console.log(`Opening chat for ${formattedPhone} ...`);
    await driver.get(url);

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

/**
 * Execute a campaign by ID
 */
async function executeCampaign(campaignId) {
    const cfg = loadSettings();
    
    // Get campaign execution data
    const executionData = campaignExecutor.getCampaignExecutionData(campaignId);
    
    console.log(`\n🚀 Executing Campaign: ${executionData.campaignName}`);
    console.log(`📱 Sending ${executionData.totalCount} messages...\n`);

    const driver = await createDriver(cfg);

    try {
        await openWhatsApp(driver);

        let successCount = 0;
        let errorCount = 0;

        for (let i = 0; i < executionData.messages.length; i++) {
            const contact = executionData.messages[i];
            try {
                await sendMessageToContact(driver, cfg, contact);
                successCount++;
                console.log(`[${i + 1}/${executionData.totalCount}] ✓ Sent to ${contact.phone}`);
            } catch (err) {
                errorCount++;
                console.error(`[${i + 1}/${executionData.totalCount}] ✗ Error sending to ${contact.phone}:`, err.message);
            }
        }

        console.log(`\n✅ Campaign execution completed!`);
        console.log(`   Success: ${successCount}`);
        console.log(`   Errors: ${errorCount}`);
    } catch (err) {
        console.error('\n❌ Fatal error during campaign execution:', err.message);
        if (err.message.includes('session not created') || err.message.includes('Chrome failed to start')) {
            console.error('\n💡 Troubleshooting tips:');
            console.error('   - Close all Chrome windows and try again');
            console.error('   - Make sure no other instance of the bot is running');
            console.error('   - Try restarting your computer');
            console.error('   - Check if Chrome is up to date\n');
        }
        throw err;
    } finally {
        // Keep browser open if configured
        // await driver.quit();
    }
}

// If run directly from command line
if (require.main === module) {
    const campaignId = process.argv[2];
    
    if (!campaignId) {
        console.error('Usage: node bot-campaign.js <campaign-id>');
        process.exit(1);
    }
    
    executeCampaign(campaignId).catch(err => {
        console.error('Campaign execution failed:', err);
        process.exit(1);
    });
}

module.exports = {
    executeCampaign
};

