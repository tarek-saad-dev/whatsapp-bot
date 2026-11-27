import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPeerCryptoHealth } from '../src/peerCryptoHealth.js';

const key = (id, remoteJid = '123@s.whatsapp.net') => ({ id, remoteJid, fromMe: false });
const bad = { stubType: 2, plaintextPresent: 'NO' };
const good = { plaintextPresent: 'YES', textLength: 4 };
const observe = (h, id, summary, peer, type = 'notify') => h.observe({ key: key(id, peer), type, summary });

test('repeated same stub is suspect; distinct failures degrade; unrelated plaintext cannot clear it', () => {
  const h = createPeerCryptoHealth(); h.setConnected(true);
  observe(h, 'a', bad); observe(h, 'a', bad);
  assert.equal(h.snapshot().suspectPeers, 1);
  observe(h, 'b', bad);
  assert.equal(h.snapshot().degradedPeers, 1);
  observe(h, 'other', good, '999@s.whatsapp.net');
  assert.equal(h.snapshot().degradedPeers, 1);
  observe(h, 'new', good);
  assert.equal(h.snapshot().status, 'TRAFFIC_RESUMED_WITH_UNRESOLVED_MESSAGES');
  observe(h, 'a', good, '123:2@s.whatsapp.net');
  assert.equal(h.snapshot().recoveredMessages, 1);
  observe(h, 'b', good);
  assert.equal(h.snapshot().recoveredEpisodes, 1);
  assert.equal(h.snapshot().status, 'NO_ACTIVE_FAILURE_OBSERVED');
});

test('ignore history, group, outgoing, nontext and ambiguous failures; no failure is not proof of health', () => {
  const h = createPeerCryptoHealth(); h.setConnected(true);
  assert.equal(observe(h, 'a', bad, undefined, 'append'), false);
  assert.equal(observe(h, 'a', bad, '123@g.us'), false);
  assert.equal(observe(h, 'a', { plaintextPresent: 'NO', contentType: 'imageMessage' }), false);
  assert.equal(h.observe({ key: {...key('a'), fromMe: true}, type: 'notify', summary: bad }), false);
  assert.equal(h.snapshot().status, 'NO_ACTIVE_FAILURE_OBSERVED');
});

test('expiry, bounded memory, overflow cannot falsely recover and disconnect clears active observations', () => {
  let now = 0;
  const h = createPeerCryptoHealth({ now: () => now, ttlMs: 100, maxPeers: 1, maxIds: 1 });
  h.setConnected(true);
  observe(h, 'a', bad); observe(h, 'b', bad); observe(h, 'a', good);
  assert.equal(h.snapshot().overflowPeers, 1);
  assert.equal(h.snapshot().recoveredEpisodes, 0);
  observe(h, 'c', bad, '789@lid');
  assert.equal(h.snapshot().evictedPeers, 1);
  now = 100;
  assert.equal(h.snapshot().suspectPeers, 0);
  assert.equal(h.snapshot().recoveredEpisodes, 0);
  observe(h, 'd', bad); h.setConnected(false); h.setConnected(true);
  assert.equal(h.snapshot().suspectPeers, 0);
  assert.equal(h.snapshot().status, 'NO_ACTIVE_FAILURE_OBSERVED');
  assert.equal(JSON.stringify(h.snapshot()).includes('@'), false);
});
