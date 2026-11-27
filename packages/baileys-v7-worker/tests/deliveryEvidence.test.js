import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryEvidence } from '../src/deliveryEvidence.js';

const out = { id: 'm1', fromMe: true, remoteJid: '123@s.whatsapp.net', remoteJidAlt: '456@lid' };
const incoming = { id: 'm2', fromMe: false, remoteJid: '123@s.whatsapp.net' };

test('socket open and server ack are not delivery proof; live plaintext plus receipt are separate observations', () => {
  const e = createDeliveryEvidence({ now: () => 1000 });
  assert.equal(e.snapshot().status, 'NOT_CONNECTED');
  e.setConnected(true);
  assert.equal(e.snapshot().status, 'UNVERIFIED');
  assert.equal(e.recordSent(out, out.remoteJid), true);
  assert.equal(e.recordUpdate(out, 2), false);
  assert.equal(e.recordInbound(incoming, 'append', true), false);
  assert.equal(e.recordInbound(incoming, 'notify', false), false);
  assert.equal(e.recordInbound(incoming, 'notify', true), true);
  assert.equal(e.snapshot().status, 'INBOUND_OBSERVED');
  assert.equal(e.recordUpdate({ ...out, remoteJid: '456:2@lid' }, 3), true);
  assert.equal(e.snapshot().status, 'BOTH_OBSERVED');
  assert.equal(e.recordUpdate(out, 4), false);
  assert.equal(e.snapshot().pendingReceiptCount, 0);
});

test('wrong recipient, unknown ID, groups, wrong direction and another account never prove delivery', () => {
  const e = createDeliveryEvidence(), other = createDeliveryEvidence();
  e.setConnected(true); other.setConnected(true);
  e.recordSent(out, out.remoteJid);
  for (const key of [{ ...out, remoteJid: '999@s.whatsapp.net' }, { ...out, id: 'wrong' }, { ...out, fromMe: false }]) assert.equal(e.recordUpdate(key, 3), false);
  assert.equal(e.recordSent({ ...out, remoteJid: '123@g.us' }, out.remoteJid), false);
  assert.equal(other.recordUpdate(out, 3), false);
  assert.equal(e.recordInbound({ ...incoming, remoteJid: '123@g.us' }, 'notify', true), false);
  assert.equal(e.snapshot().status, 'UNVERIFIED');
});

test('reconnect resets evidence; bounded and expired entries do not prove delivery', () => {
  let now = 0;
  const e = createDeliveryEvidence({ now: () => now, ttlMs: 100, maxEntries: 1 });
  e.setConnected(true);
  e.recordSent(out, out.remoteJid);
  e.recordSent({ ...out, id: 'second' }, out.remoteJid);
  assert.equal(e.recordUpdate(out, 3), false);
  now = 100;
  assert.equal(e.recordUpdate({ ...out, id: 'second' }, 3), false);
  e.recordSent(out, out.remoteJid);
  e.recordUpdate(out, 5);
  assert.equal(e.snapshot().status, 'OUTBOUND_DELIVERY_OBSERVED');
  e.setConnected(false); e.setConnected(true);
  assert.equal(e.snapshot().status, 'UNVERIFIED');
  assert.equal(e.recordUpdate(out, 3), false);
  assert.equal(e.snapshot().lastOutboundDeliveryAckAt, null);
});
