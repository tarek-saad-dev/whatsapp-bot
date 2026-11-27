import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReconnectPolicy } from '../src/reconnectPolicy.js';
test('only known transient disconnects schedule bounded backoff', () => {
  const p = createReconnectPolicy();
  assert.deepEqual(p.closed(408), { action: 'RETRY_SCHEDULED', delayMs: 1000 });
  assert.deepEqual(p.closed(515), { action: 'RETRY_SCHEDULED', delayMs: 2000 });
  assert.equal(p.closed(428).action, 'RETRY_SCHEDULED');
  assert.equal(p.closed(503).action, 'RETRY_SCHEDULED');
  assert.equal(p.closed(408).delayMs, 16000);
  assert.equal(p.closed(408).delayMs, 30000);
  assert.equal(p.closed(408).action, 'RETRY_EXHAUSTED');
});
test('unknown and terminal codes never trigger another socket', () => {
  for (const code of [undefined, null, 403, 411, 440, 500, 999]) {
    const p = createReconnectPolicy();
    assert.equal(p.closed(code).action, 'OPERATOR_REVIEW');
    assert.equal(p.snapshot().attempts, 0);
  }
  assert.equal(createReconnectPolicy().closed(401).action, 'LOGGED_OUT');
});
test('brief opens do not reset retry budget; stable open does', () => {
  let now = 0;
  const p = createReconnectPolicy({ now: () => now, maxAttempts: 2 });
  p.closed(408); p.opened(); now = 1000;
  assert.equal(p.closed(428).delayMs, 2000);
  p.opened(); now = 2000;
  assert.equal(p.closed(408).action, 'RETRY_EXHAUSTED');
  p.opened(); now = 62000;
  assert.equal(p.snapshot().attempts, 0);
  assert.equal(p.closed(408).delayMs, 1000);
  p.startFailed(); assert.equal(p.snapshot().action, 'OPERATOR_REVIEW');
  p.stopped(); assert.equal(p.snapshot().action, 'STOPPED');
});
