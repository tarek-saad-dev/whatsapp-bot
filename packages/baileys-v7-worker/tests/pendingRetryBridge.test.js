import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetryStore } from '../src/retryStore.js';
import { createPendingRetryBridge } from '../src/pendingRetryBridge.js';
const key = { id: 'm1', remoteJid: '123@s.whatsapp.net', fromMe: true };
const msg = { conversation: 'synthetic test' };
test('early retry waits for the exact original generated message', async () => {
  const store = createRetryStore(), bridge = createPendingRetryBridge(store);
  const release = bridge.reserve(key);
  const waiting = bridge.getMessage(key);
  assert.equal(await bridge.getMessage({ ...key, remoteJid: '999@s.whatsapp.net' }), undefined);
  assert.equal(await bridge.getMessage({ ...key, fromMe: false }), undefined);
  store.put(key, msg);
  release();
  assert.deepEqual(await waiting, msg);
  assert.equal(bridge.stats().pending, 0);
  assert.equal(bridge.stats().waited, 1);
});
test('failed or ambiguous sends do not invent content; timeout and clear are bounded', async () => {
  const store = createRetryStore(), bridge = createPendingRetryBridge(store, { waitMs: 10 });
  let done = bridge.reserve(key);
  const failed = bridge.getMessage(key); done();
  assert.equal(await failed, undefined);
  done = bridge.reserve(key);
  assert.equal(await bridge.getMessage(key), undefined);
  assert.equal(bridge.stats().timeouts, 1);
  const stopped = bridge.getMessage(key); bridge.clear();
  assert.equal(await stopped, undefined); done();
  assert.equal(bridge.stats().pending, 0);
});
test('different accounts and unknown aliases never wait for another recipient', async () => {
  const a = createPendingRetryBridge(createRetryStore()), b = createPendingRetryBridge(createRetryStore());
  const done = a.reserve(key);
  assert.equal(await a.getMessage({ ...key, remoteJid: '456@lid' }), undefined);
  assert.equal(await b.getMessage(key), undefined);
  assert.equal(a.stats().waited, 0); done();
});
