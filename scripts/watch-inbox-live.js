require('dotenv').config();
const whatsappService = require('../services/whatsappService');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('Waiting for your WhatsApp message (90 seconds)...');
  await whatsappService.startInboxListener({ initDriver: true });

  const seen = new Set();
  for (let i = 0; i < 45; i += 1) {
    await sleep(2000);
    const inbox = whatsappService.getInbox(20);
    for (const msg of inbox.messages) {
      if (seen.has(msg.messageId)) continue;
      seen.add(msg.messageId);
      console.log('CAPTURED_MESSAGE_JSON_START');
      console.log(JSON.stringify(msg, null, 2));
      console.log('CAPTURED_MESSAGE_JSON_END');
    }
    if (i % 5 === 0) {
      console.log(`... watching ${(i + 1) * 2}s | stored=${inbox.count} trigger=${inbox.triggerInstalled}`);
    }
  }

  const final = whatsappService.getInbox(20);
  console.log('FINAL_INBOX_JSON_START');
  console.log(JSON.stringify(final, null, 2));
  console.log('FINAL_INBOX_JSON_END');

  await whatsappService.stopInboxListener();
  await whatsappService.closeDriver();
}

main().catch(async (err) => {
  console.error('Watch failed:', err.message);
  try { await whatsappService.closeDriver(); } catch (_) {}
  process.exit(1);
});
