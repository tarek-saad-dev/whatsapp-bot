const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createInboxSpool } = require('../services/inbox/inboxSpool');

test('v7 durable spool survives restart and prevents duplicate capture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvo-reliability-'));
  try {
    const spoolFile = path.join(dir, 'v7-inbound-spool.json');
    const first = createInboxSpool({ spoolFile });
    first.capture({ providerMessageId: 'wa-123', content: { text: 'hello' } });
    first.capture({ providerMessageId: 'wa-123', content: { text: 'duplicate' } });
    assert.equal(first.getStats().pending, 1);
    const restarted = createInboxSpool({ spoolFile });
    assert.equal(restarted.getPendingForDelivery().length, 1);
    assert.equal(restarted.getPendingForDelivery()[0].normalizedEvent.content.text, 'hello');

    restarted.markRetry('wa-123', {
      nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
      error: 'NETWORK',
    });
    const retried = createInboxSpool({ spoolFile });
    assert.equal(retried.getPendingForDelivery().length, 1);
    retried.markDelivered('wa-123');
    assert.equal(createInboxSpool({ spoolFile }).getPendingForDelivery().length, 0);
    assert.equal(createInboxSpool({ spoolFile }).getStats().delivered, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
