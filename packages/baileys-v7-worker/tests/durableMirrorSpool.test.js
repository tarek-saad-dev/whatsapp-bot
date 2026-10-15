import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDurableMirrorSpool } from '../src/durableMirrorSpool.js';

test('large history batches stay durable, deduplicate, and recover after restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drvo-history-'));
  try {
    const journalFile = path.join(dir, 'mirror.ndjson');
    const one = createDurableMirrorSpool({ journalFile, compactAfterBytes: 9000 });
    for (let i = 0; i < 1200; i++) {
      one.capture({ providerMessageId: 'id-' + i, payload: { kind: 'message', text: 'حجز' + i } });
    }
    one.capture({ providerMessageId: 'id-0', payload: { text: 'duplicate' } });
    assert.equal(one.getStats().total, 1200);
    assert.equal(one.getPendingForDelivery().length, 1200);
    for (let i = 0; i < 400; i++) one.markDelivered('id-' + i);
    one.markRetry('id-401', { nextRetryAt: new Date(Date.now() - 1000).toISOString() });

    const reboot = createDurableMirrorSpool({ journalFile });
    assert.equal(reboot.getStats().total, 1200);
    assert.equal(reboot.getStats().delivered, 400);
    assert.equal(reboot.getPendingForDelivery().length, 800);
    assert.equal(reboot.hasProviderMessageId('id-401'), true);
    reboot.markDelivered('id-401');
    assert.equal(createDurableMirrorSpool({ journalFile }).getStats().delivered, 401);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
