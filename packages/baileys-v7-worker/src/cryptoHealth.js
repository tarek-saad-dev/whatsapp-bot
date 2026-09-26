'use strict';

/**
 * Crypto health telemetry for selective Baileys engines.
 * Diagnostics only — no auto engine switch.
 *
 * Lifetime counters stay for diagnostics.
 * Active failure episode is cleared on plaintext recovery.
 */

export function createCryptoHealth() {
  const state = {
    plaintextInboundCount: 0,
    decryptFailureCount: 0,
    messageAbsentFromNodeCount: 0,
    lastPlaintextInboundAt: null,
    lastDecryptFailureAt: null,
    activeFailureStreak: 0,
    failureEpisodeStartedAt: null,
  };
  /** Lifetime distinct failure ids (diagnostic). */
  const lifetimeFailureIds = new Set();
  /** Distinct ids in the current unrecovered episode. */
  const activeFailureIds = new Set();

  function clearActiveEpisode() {
    state.activeFailureStreak = 0;
    state.failureEpisodeStartedAt = null;
    activeFailureIds.clear();
  }

  function recordPlaintext() {
    state.plaintextInboundCount += 1;
    state.lastPlaintextInboundAt = new Date().toISOString();
    // Recovery: clear active unresolved crypto episode.
    clearActiveEpisode();
  }

  function recordDecryptFailure({ absentFromNode = false, providerMessageId = null } = {}) {
    const now = new Date().toISOString();
    state.decryptFailureCount += 1;
    state.lastDecryptFailureAt = now;
    if (absentFromNode) state.messageAbsentFromNodeCount += 1;

    if (!state.failureEpisodeStartedAt) {
      state.failureEpisodeStartedAt = now;
    }
    state.activeFailureStreak += 1;

    const id = providerMessageId != null ? String(providerMessageId).trim() : '';
    if (id) {
      lifetimeFailureIds.add(id);
      activeFailureIds.add(id);
    }
  }

  function snapshot() {
    return {
      ...state,
      distinctDecryptFailureMessageIds: lifetimeFailureIds.size,
      activeFailureDistinctIds: activeFailureIds.size,
      // Provisional — supervisor re-classifies with READY + episode age.
      status: state.plaintextInboundCount > 0 && state.activeFailureStreak === 0
        ? 'HEALTHY'
        : state.activeFailureStreak === 0 && state.plaintextInboundCount === 0
          ? 'UNKNOWN'
          : state.activeFailureStreak >= 3 && activeFailureIds.size >= 2
            ? 'DEGRADED_CRYPTO'
            : 'SUSPECT',
      cryptoHealth: undefined,
    };
  }

  function finalizeSnapshot() {
    const s = snapshot();
    s.cryptoHealth = s.status;
    return s;
  }

  return {
    recordPlaintext,
    recordDecryptFailure,
    snapshot: finalizeSnapshot,
    clearActiveEpisode,
  };
}
