require('dotenv').config();
const whatsappService = require('../services/whatsappService');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('Starting trigger-based inbox test...');
  console.log('Send yourself a WhatsApp message now — the bot reads preview from chat list.\n');

  await whatsappService.startInboxListener({ initDriver: true });

  for (let i = 0; i < 12; i += 1) {
    await sleep(2000);
    const inbox = whatsappService.getInbox(10);
    const status = inbox;
    console.log(
      `[${i + 1}/12] listening=${status.listening} trigger=${status.triggerInstalled} stored=${status.count}`,
    );
    if (inbox.messages.length > 0) {
      console.log('\nLatest messages:');
      for (const msg of inbox.messages.slice(-3)) {
        console.log(`  ${msg.chatTitle}: ${msg.text}`);
      }
    }
  }

  const final = whatsappService.getInbox(20);
  console.log('\nDone. Total stored:', final.count);
  console.log(JSON.stringify(final.messages, null, 2));

  await whatsappService.stopInboxListener();
  await whatsappService.closeDriver();
}

main().catch(async (err) => {
  console.error('Trigger inbox test failed:', err.message);
  try {
    await whatsappService.closeDriver();
  } catch (_) {}
  process.exit(1);
});
