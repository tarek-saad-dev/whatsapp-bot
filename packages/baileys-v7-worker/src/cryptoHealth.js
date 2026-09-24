'use strict';

/**
 * Crypto health telemetry for selective Baileys engines.
 * Diagnostics only — no auto engine switch.
 */

export function createCryptoHealth() {
  const state = {
    plaintextInboundCount: 0,
    decryptFailureCount: 0,
    messageAbsentFromNodeCount: 0,
    lastPlaintextInboundAt: null,
    lastDecryptFailureAt: null,
  };

  function recordPlaintext() {
    state.plaintextInboundCount += 1;
    state.lastPlaintextInboundAt = new Date().toISOString();
  }

  function recordDecryptFailure({ absentFromNode = false } = {}) {
    state.decryptFailureCount += 1;
    state.lastDecryptFailureAt = new Date().toISOString();
    if (absentFromNode) state.messageAbsentFromNodeCount += 1;
  }

  function snapshot() {
    let cryptoHealth = 'UNKNOWN';
    if (state.plaintextInboundCount > 0 && state.decryptFailureCount === 0) {
      cryptoHealth = 'HEALTHY';
    } else if (state.decryptFailureCount > 0 && state.plaintextInboundCount === 0) {
      cryptoHealth = 'DEGRADED_CRYPTO';
    } else if (state.decryptFailureCount > 0 && state.plaintextInboundCount > 0) {
      cryptoHealth = 'DEGRADED_CRYPTO';
    } else if (state.plaintextInboundCount > 0) {
      cryptoHealth = 'HEALTHY';
    }
    return { ...state, cryptoHealth };
  }

  return { recordPlaintext, recordDecryptFailure, snapshot };
}
