require('dotenv').config();
const { Builder } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

async function main() {
  const opts = new chrome.Options();
  opts.debuggerAddress('127.0.0.1:9222');
  console.log('Connecting Selenium to Chrome on 9222...');
  const driver = await Promise.race([
    new Builder().forBrowser('chrome').setChromeOptions(opts).build(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT 30s')), 30000)),
  ]);
  console.log('Connected. Title:', await driver.getTitle());
  console.log('URL:', await driver.getCurrentUrl());
  await driver.quit();
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
