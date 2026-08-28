require('dotenv').config();
const whatsappService = require('../services/whatsappService');
const { scrapeChatRows, scrapeOpenConversation } = require('../services/inbox/pageScripts');

async function main() {
  const drv = await whatsappService.getOrCreateDriver();
  const rows = await drv.executeScript(scrapeChatRows);
  console.log('Chat rows:', JSON.stringify(rows, null, 2));

  const open = await drv.executeScript(scrapeOpenConversation);
  console.log('\nOpen conversation:', JSON.stringify({
    chatTitle: open.chatTitle,
    messageCount: open.messages.length,
    lastMessages: open.messages.slice(-5),
  }, null, 2));

  await whatsappService.closeDriver();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
