import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIncidentMonitor, detectConditions } from '../src/incidentMonitor.js';
const ready = { state: 'READY', inboundDelivery: { running: true, pending: 0 } };
const crypto = { ...ready, peerCryptoHealth: { status: 'DEGRADED', jid: 'secret' } };
test('idle, pairing and absence of delivery proof do not create incidents', () => {
  assert.deepEqual(detectConditions(ready), []);
  assert.deepEqual(detectConditions({ state: 'QR_REQUIRED', inboundDelivery: { running: false } }), []);
  assert.deepEqual(detectConditions({ ...ready, deliveryEvidence: { status: 'UNVERIFIED' } }), []);
});
test('debounce transient problems and emit one open/close per observed episode', () => {
  let t = 0; const events = [];
  const m = createIncidentMonitor({ now: () => t, onTransition: e => events.push(e) });
  m.sample(crypto); t = 15000; m.sample(ready); assert.equal(events.length, 0);
  t = 20000; m.sample(crypto); t = 50000; m.sample(crypto); t = 65000; m.sample(crypto);
  assert.equal(events.length, 1);
  assert.equal(m.snapshot().active[0].durationMs, 45000);
  t = 80000; m.sample(ready); m.sample(ready);
  assert.equal(events.length, 2);
  assert.equal(m.snapshot().recent[0].durationMs, 60000);
  assert.equal(m.snapshot().recent[0].outcome, 'CONDITION_NO_LONGER_OBSERVED');
  assert.equal(JSON.stringify(m.snapshot()).includes('secret'), false);
});
test('terminal review immediate, independent incidents bounded; historical error with empty queue ignored', () => {
  const m = createIncidentMonitor({ graceMs: 0, maxRecent: 1 });
  m.sample({ state: 'ERROR', socketRecovery: { action: 'RETRY_EXHAUSTED' } });
  assert.equal(m.snapshot().active[0].issue, 'SOCKET_REVIEW');
  m.sample({ ...crypto, inboundDelivery: { running: false, pending: 1, lastErrorCode: 'NETWORK' } });
  assert.equal(m.snapshot().active.length, 3);
  m.sample({ ...ready, inboundDelivery: { running: true, pending: 0, lastErrorCode: 'NETWORK' } });
  assert.equal(m.snapshot().active.length, 0);
  assert.equal(m.snapshot().recent.length, 1);
});
