require('dotenv').config();
const whatsappService = require('../services/whatsappService');
const { clickChatRowByTitle } = require('../services/inbox/pageScripts');

const probeScript = () => {
  const main = document.querySelector('#main');
  if (!main) return { error: 'no #main' };

  const selectors = [
    '#main div[data-id]',
    '#main [data-id]',
    '#main div[role="row"]',
    '#main [data-testid*="msg"]',
    '#main .message-in',
    '#main .message-out',
    '#main span.selectable-text',
    '#main div.copyable-text',
  ];

  const counts = {};
  for (const sel of selectors) {
    counts[sel] = document.querySelectorAll(sel).length;
  }

  const sampleIds = Array.from(document.querySelectorAll('[data-id]'))
    .slice(0, 5)
    .map((el) => ({
      tag: el.tagName,
      id: el.getAttribute('data-id'),
      className: String(el.className || '').slice(0, 80),
      text: (el.innerText || '').slice(0, 60),
    }));

  const header = document.querySelector('#main header span[title]');
  return {
    headerTitle: header ? header.getAttribute('title') : null,
    counts,
    sampleIds,
    mainHtmlSnippet: main.innerHTML.slice(0, 500),
  };
};

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const drv = await whatsappService.getOrCreateDriver();
  await drv.executeScript(clickChatRowByTitle, 'Tarek Saad');
  await sleep(2000);
  const probe = await drv.executeScript(probeScript);
  console.log(JSON.stringify(probe, null, 2));
  await whatsappService.closeDriver();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
