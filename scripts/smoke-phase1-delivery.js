'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createInboxSpool } = require('../services/inbox/inboxSpool');
const { createInboxDeliveryWorker } = require('../services/inbox/inboxDeliveryWorker');
const { normalizeMessage } = require('../services/inbox/normalizeMessage');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-phase1-smoke-'));
  const spoolFile = path.join(tempDir, 'spool.json');
  const spool = createInboxSpool({ spoolFile });

  const stamp = Date.now();
  const event = normalizeMessage({
    id: `false_201557994946@c.us_SMOKE${stamp}`,
    text: `phase1-smoke-${stamp}`,
    className: 'message-in',
  }, 'Tarek Saad');

  spool.capture(event);
  console.log('Captured locally:', event.providerMessageId);

  const worker = createInboxDeliveryWorker({
    spool,
    webhookUrl: 'http://127.0.0.1:4010/api/internal/messaging/inbox/whatsapp',
    webhookToken: process.env.WHATSAPP_INBOX_WEBHOOK_TOKEN || 'test-token',
  });

  await worker.processRecord(spool.getPendingForDelivery()[0]);
  console.log('Delivery stats:', spool.getStats());

  const fetchImpl = global.fetch;
  const dupRes = await fetchImpl('http://127.0.0.1:4010/api/internal/messaging/inbox/whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify(event),
  });
  const dupBody = await dupRes.json();
  console.log('Duplicate replay response:', dupRes.status, dupBody);

  const spool2 = createInboxSpool({ spoolFile });
  console.log('Reloaded pending:', spool2.getStats().pending, 'delivered:', spool2.getStats().delivered);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
