require('dotenv').config();
const whatsappService = require('../services/whatsappService');

async function main() {
  console.log('Initializing WhatsApp driver...');
  await whatsappService.getOrCreateDriver();
  console.log('Driver ready. Polling inbox once...');

  const status = await whatsappService.getStatus();
  console.log('Status:', JSON.stringify(status, null, 2));

  const fresh = await whatsappService.pollInboxOnce();
  console.log(`\nNew messages this poll: ${fresh.length}`);
  for (const msg of fresh) {
    console.log('---');
    console.log(`From: ${msg.chatTitle}${msg.phone ? ` (${msg.phone})` : ''}`);
    console.log(`Text: ${msg.text}`);
  }

  const inbox = whatsappService.getInbox(20);
  console.log(`\nInbox total stored: ${inbox.count}`);
  console.log(JSON.stringify(inbox.messages, null, 2));

  await whatsappService.closeDriver();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Live inbox test failed:', err.message);
  try {
    await whatsappService.closeDriver();
  } catch (_) {}
  process.exit(1);
});
