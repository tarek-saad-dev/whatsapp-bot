import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCryptoHealth } from '../src/cryptoHealth.js';

describe('v7 crypto health episode', () => {
  it('starts UNKNOWN then HEALTHY after plaintext', () => {
    const h = createCryptoHealth();
    assert.equal(h.snapshot().status, 'UNKNOWN');
    h.recordPlaintext();
    assert.equal(h.snapshot().status, 'HEALTHY');
  });

  it('one decrypt failure is SUSPECT; plaintext clears to HEALTHY', () => {
    const h = createCryptoHealth();
    h.recordDecryptFailure({ providerMessageId: 'm1' });
    assert.equal(h.snapshot().status, 'SUSPECT');
    assert.equal(h.snapshot().activeFailureStreak, 1);
    h.recordPlaintext();
    const s = h.snapshot();
    assert.equal(s.status, 'HEALTHY');
    assert.equal(s.activeFailureStreak, 0);
    assert.equal(s.decryptFailureCount, 1); // lifetime retained
  });

  it('three failures / two ids → DEGRADED; plaintext recovers to HEALTHY', () => {
    const h = createCryptoHealth();
    h.recordDecryptFailure({ providerMessageId: 'a' });
    h.recordDecryptFailure({ providerMessageId: 'b' });
    h.recordDecryptFailure({ providerMessageId: 'a' });
    const bad = h.snapshot();
    assert.equal(bad.activeFailureStreak, 3);
    assert.equal(bad.activeFailureDistinctIds, 2);
    assert.equal(bad.status, 'DEGRADED_CRYPTO');
    h.recordPlaintext();
    assert.equal(h.snapshot().status, 'HEALTHY');
    assert.equal(h.snapshot().activeFailureStreak, 0);
  });
});
