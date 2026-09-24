import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCryptoHealth } from '../src/cryptoHealth.js';

describe('v7 crypto health', () => {
  it('starts UNKNOWN then HEALTHY after plaintext', () => {
    const h = createCryptoHealth();
    assert.equal(h.snapshot().cryptoHealth, 'UNKNOWN');
    h.recordPlaintext();
    assert.equal(h.snapshot().cryptoHealth, 'HEALTHY');
    assert.equal(h.snapshot().plaintextInboundCount, 1);
  });

  it('marks DEGRADED_CRYPTO on decrypt failure', () => {
    const h = createCryptoHealth();
    h.recordDecryptFailure({ absentFromNode: true });
    const s = h.snapshot();
    assert.equal(s.cryptoHealth, 'DEGRADED_CRYPTO');
    assert.equal(s.messageAbsentFromNodeCount, 1);
  });
});
