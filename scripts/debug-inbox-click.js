require('dotenv').config();
const whatsappService = require('../services/whatsappService');
const { summarizeUnreadChats } = require('../services/inbox/inboxLogic');
const { scrapeChatRows, clickChatRowByTitle, scrapeOpenConversation } = require('../services/inbox/pageScripts');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const drv = await whatsappService.getOrCreateDriver();
  const rows = await drv.executeScript(scrapeChatRows);
  const unread = summarizeUnreadChats(rows);
  console.log('Unread chats:', unread);

  for (const chat of unread.slice(0, 2)) {
    console.log(`\nOpening: ${chat.title} (${chat.unreadCount} unread)`);
    const clicked = await drv.executeScript(clickChatRowByTitle, chat.title);
    console.log('Clicked:', clicked);
    await sleep(1500);
    const open = await drv.executeScript(scrapeOpenConversation);
    console.log('Messages found:', open.messages.length);
    console.log('Last 3:', open.messages.slice(-3));
  }

  await whatsappService.closeDriver();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
