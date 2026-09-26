'use strict';

/**
 * Deterministic WhatsApp compatibility classifier (Phase 1 — observation only).
 *
 * Lifetime counters (plaintextInboundCount, decryptFailureCount, …) are
 * diagnostics only. Classification uses ACTIVE FAILURE EPISODE state:
 *
 *   activeFailureStreak
 *   activeFailureDistinctIds
 *   failureEpisodeStartedAt
 *   lastPlaintextInboundAt / lastDecryptFailureAt
 *
 * DEGRADED_CRYPTO when ALL are true:
 *   · socketReady
 *   · activeFailureStreak ≥ 3
 *   · activeFailureDistinctIds ≥ 2
 *   · episode is recent (within EPISODE_MAX_AGE_MS, default 30m)
 *   · no plaintext recovery after the episode started
 *
 * Recovery: any genuine plaintext after episode start clears the active
 * streak → HEALTHY (lifetime failure counters may remain > 0).
 *
 * Stale / historical failures alone never degrade.
 * Does not mutate runtimeEngine.
 */

const COMPATIBILITY = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  HEALTHY: 'HEALTHY',
  SUSPECT: 'SUSPECT',
  DEGRADED_CRYPTO: 'DEGRADED_CRYPTO',
});

const RUNTIME_ENGINE = Object.freeze({
  V6: 'BAILEYS_V6',
  V7: 'BAILEYS_V7',
});

const DEGRADED_MIN_FAILURES = 3;
const DEGRADED_MIN_DISTINCT_IDS = 2;
/** Active episode older than this is treated as stale (not DEGRADED). */
const EPISODE_MAX_AGE_MS = 30 * 60 * 1000;

function parseIsoMs(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * Resolve active-episode fields. Prefer explicit episode inputs; fall back to
 * timestamp heuristics without treating lifetime totals as the decision.
 */
function resolveActiveEpisode(input = {}, nowMs = Date.now()) {
  const lastPlainMs = parseIsoMs(input.lastPlaintextInboundAt);
  const lastFailMs = parseIsoMs(input.lastDecryptFailureAt);
  const episodeStartMs = parseIsoMs(input.failureEpisodeStartedAt);

  const hasExplicitStreak = input.activeFailureStreak != null
    || input.consecutiveUnrecoveredDecryptFailures != null;
  let activeFailureStreak = Math.max(
    0,
    Number(
      input.activeFailureStreak
      ?? input.consecutiveUnrecoveredDecryptFailures
      ?? 0,
    ) || 0,
  );
  let activeFailureDistinctIds = Math.max(
    0,
    Number(input.activeFailureDistinctIds ?? input.distinctDecryptFailureMessageIds ?? 0) || 0,
  );

  // Plaintext after last failure / after episode start ⇒ recovered.
  const recoveredByPlaintext = Boolean(
    lastPlainMs
    && (
      (lastFailMs && lastPlainMs >= lastFailMs)
      || (episodeStartMs && lastPlainMs >= episodeStartMs)
    ),
  );

  if (recoveredByPlaintext) {
    return {
      activeFailureStreak: 0,
      activeFailureDistinctIds: 0,
      failureEpisodeStartedAt: null,
      episodeAgeMs: null,
      episodeRecent: false,
      recoveredByPlaintext: true,
    };
  }

  // Without explicit streak, do NOT use lifetime decryptFailureCount.
  // Only treat as an active episode when we have a recent failure timestamp
  // and no later plaintext — and only then use distinct ids if provided as
  // activeFailureDistinctIds (lifetime distinct ids alone are insufficient).
  if (!hasExplicitStreak) {
    if (lastFailMs && (!lastPlainMs || lastFailMs > lastPlainMs)) {
      const age = nowMs - lastFailMs;
      const recent = age >= 0 && age <= EPISODE_MAX_AGE_MS;
      // Ambiguous historical totals → never invent streak ≥ 3 from lifetime.
      // Leave streak unknown (0) so we stay SUSPECT/UNKNOWN, not DEGRADED.
      return {
        activeFailureStreak: 0,
        activeFailureDistinctIds: 0,
        failureEpisodeStartedAt: input.failureEpisodeStartedAt || input.lastDecryptFailureAt || null,
        episodeAgeMs: age,
        episodeRecent: recent,
        recoveredByPlaintext: false,
        ambiguousWithoutEpisode: true,
      };
    }
    return {
      activeFailureStreak: 0,
      activeFailureDistinctIds: 0,
      failureEpisodeStartedAt: null,
      episodeAgeMs: null,
      episodeRecent: false,
      recoveredByPlaintext: false,
    };
  }

  const startMs = episodeStartMs || lastFailMs;
  const episodeAgeMs = startMs != null ? Math.max(0, nowMs - startMs) : null;
  const episodeRecent = episodeAgeMs != null && episodeAgeMs <= EPISODE_MAX_AGE_MS;

  return {
    activeFailureStreak,
    activeFailureDistinctIds: episodeRecent ? activeFailureDistinctIds : 0,
    failureEpisodeStartedAt: input.failureEpisodeStartedAt || null,
    episodeAgeMs,
    episodeRecent,
    recoveredByPlaintext: false,
  };
}

/**
 * @param {object} input
 * @param {number} [input.plaintextInboundCount] — lifetime diagnostic
 * @param {number} [input.decryptFailureCount] — lifetime diagnostic (not decision)
 * @param {number} [input.activeFailureStreak]
 * @param {number} [input.consecutiveUnrecoveredDecryptFailures]
 * @param {number} [input.activeFailureDistinctIds]
 * @param {string|null} [input.failureEpisodeStartedAt]
 * @param {string|null} [input.lastPlaintextInboundAt]
 * @param {string|null} [input.lastDecryptFailureAt]
 * @param {boolean} [input.socketReady]
 * @param {number} [input.nowMs]
 */
function classifyCompatibility(input = {}) {
  const plaintext = Math.max(0, Number(input.plaintextInboundCount) || 0);
  const lifetimeFailures = Math.max(0, Number(input.decryptFailureCount) || 0);
  const socketReady = Boolean(input.socketReady);
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const episode = resolveActiveEpisode(input, nowMs);

  if (plaintext === 0 && lifetimeFailures === 0 && episode.activeFailureStreak === 0) {
    return {
      status: COMPATIBILITY.UNKNOWN,
      reason: 'insufficient_inbound_evidence',
    };
  }

  // Recovery: plaintext after failure episode → HEALTHY automatically.
  if (episode.recoveredByPlaintext && plaintext > 0) {
    return {
      status: COMPATIBILITY.HEALTHY,
      reason: 'plaintext_recovery_cleared_failure_episode',
    };
  }

  if (plaintext > 0 && episode.activeFailureStreak === 0) {
    return {
      status: COMPATIBILITY.HEALTHY,
      reason: 'plaintext_inbound_ok',
    };
  }

  // Not READY → never DEGRADED from crypto counters alone.
  if (!socketReady && episode.activeFailureStreak > 0) {
    return {
      status: COMPATIBILITY.SUSPECT,
      reason: 'socket_not_ready_crypto_deferred',
    };
  }

  // Stale episode → ignore for DEGRADED.
  if (episode.activeFailureStreak > 0 && episode.episodeRecent === false) {
    if (plaintext > 0) {
      return {
        status: COMPATIBILITY.HEALTHY,
        reason: 'stale_failure_episode_ignored_after_plaintext',
      };
    }
    return {
      status: COMPATIBILITY.SUSPECT,
      reason: 'stale_failure_episode_ignored',
    };
  }

  const meetsDegraded =
    socketReady
    && episode.episodeRecent
    && episode.activeFailureStreak >= DEGRADED_MIN_FAILURES
    && episode.activeFailureDistinctIds >= DEGRADED_MIN_DISTINCT_IDS;

  if (meetsDegraded) {
    return {
      status: COMPATIBILITY.DEGRADED_CRYPTO,
      reason: `active_episode_failures_${episode.activeFailureStreak}_distinct_${episode.activeFailureDistinctIds}`,
    };
  }

  if (episode.activeFailureStreak === 1) {
    return {
      status: COMPATIBILITY.SUSPECT,
      reason: 'single_active_decrypt_failure',
    };
  }

  if (episode.activeFailureStreak > 0) {
    return {
      status: COMPATIBILITY.SUSPECT,
      reason: 'active_failures_below_degraded_threshold',
    };
  }

  // Lifetime failures with no active episode (ambiguous / historical) + plaintext
  if (plaintext > 0) {
    return {
      status: COMPATIBILITY.HEALTHY,
      reason: 'plaintext_inbound_ok',
    };
  }

  if (lifetimeFailures > 0) {
    return {
      status: COMPATIBILITY.SUSPECT,
      reason: 'historical_failures_no_active_episode',
    };
  }

  return {
    status: COMPATIBILITY.UNKNOWN,
    reason: 'insufficient_inbound_evidence',
  };
}

function recommendRuntimeEngine(input = {}) {
  const engine = input.runtimeEngine === RUNTIME_ENGINE.V7
    ? RUNTIME_ENGINE.V7
    : RUNTIME_ENGINE.V6;
  const status = String(input.compatibilityStatus || '');

  if (status === COMPATIBILITY.DEGRADED_CRYPTO && engine === RUNTIME_ENGINE.V6) {
    return RUNTIME_ENGINE.V7;
  }
  return engine;
}

function buildCryptoHealthStatus(counters = {}, opts = {}) {
  const plaintextInboundCount = Math.max(0, Number(counters.plaintextInboundCount) || 0);
  const decryptFailureCount = Math.max(0, Number(counters.decryptFailureCount) || 0);
  const messageAbsentFromNodeCount = Math.max(
    0,
    Number(counters.messageAbsentFromNodeCount) || 0,
  );
  const classified = classifyCompatibility({
    ...counters,
    plaintextInboundCount,
    decryptFailureCount,
    messageAbsentFromNodeCount,
    socketReady: opts.socketReady,
    nowMs: opts.nowMs,
  });

  return {
    status: classified.status,
    plaintextInboundCount,
    decryptFailureCount,
    messageAbsentFromNodeCount,
    lastPlaintextInboundAt: counters.lastPlaintextInboundAt || null,
    lastDecryptFailureAt: counters.lastDecryptFailureAt || null,
    distinctDecryptFailureMessageIds: Math.max(
      0,
      Number(counters.distinctDecryptFailureMessageIds) || 0,
    ),
    activeFailureStreak: Math.max(0, Number(counters.activeFailureStreak) || 0),
    activeFailureDistinctIds: Math.max(
      0,
      Number(counters.activeFailureDistinctIds) || 0,
    ),
    failureEpisodeStartedAt: counters.failureEpisodeStartedAt || null,
    cryptoHealth: classified.status,
  };
}

function normalizeV6InboundCapture(capture = {}) {
  const plaintextInboundCount = Math.max(0, Number(capture.captured) || 0);
  const decryptFailureCount = Math.max(0, Number(capture.decryptFailed) || 0);
  const messageAbsentFromNodeCount = Math.max(
    0,
    Number(capture.messageAbsentFromNodeCount) || 0,
  );

  let lastPlaintextInboundAt = capture.lastPlaintextInboundAt || null;
  let lastDecryptFailureAt = capture.lastDecryptFailureAt || null;
  if (!lastPlaintextInboundAt && plaintextInboundCount > 0 && capture.lastEventAt) {
    lastPlaintextInboundAt = capture.lastEventAt;
  }

  return {
    plaintextInboundCount,
    decryptFailureCount,
    messageAbsentFromNodeCount,
    distinctDecryptFailureMessageIds: Math.max(
      0,
      Number(capture.distinctDecryptFailureMessageIds) || 0,
    ),
    lastPlaintextInboundAt,
    lastDecryptFailureAt,
    activeFailureStreak: Math.max(0, Number(capture.activeFailureStreak) || 0),
    activeFailureDistinctIds: Math.max(
      0,
      Number(capture.activeFailureDistinctIds) || 0,
    ),
    failureEpisodeStartedAt: capture.failureEpisodeStartedAt || null,
  };
}

function attachCompatibilityDiagnostics(status = {}, opts = {}) {
  const runtimeEngine = status.runtimeEngine === RUNTIME_ENGINE.V7
    ? RUNTIME_ENGINE.V7
    : RUNTIME_ENGINE.V6;
  const socketReady = Boolean(status.ready)
    || String(status.state || '').toUpperCase() === 'READY';

  let counters;
  if (status.cryptoHealth && typeof status.cryptoHealth === 'object') {
    const ch = status.cryptoHealth;
    counters = {
      plaintextInboundCount: ch.plaintextInboundCount,
      decryptFailureCount: ch.decryptFailureCount,
      messageAbsentFromNodeCount: ch.messageAbsentFromNodeCount,
      distinctDecryptFailureMessageIds: ch.distinctDecryptFailureMessageIds,
      lastPlaintextInboundAt: ch.lastPlaintextInboundAt,
      lastDecryptFailureAt: ch.lastDecryptFailureAt,
      activeFailureStreak: ch.activeFailureStreak,
      activeFailureDistinctIds: ch.activeFailureDistinctIds,
      failureEpisodeStartedAt: ch.failureEpisodeStartedAt,
    };
  } else if (status.inboundCapture) {
    counters = normalizeV6InboundCapture(status.inboundCapture);
  } else {
    counters = {
      plaintextInboundCount: 0,
      decryptFailureCount: 0,
      messageAbsentFromNodeCount: 0,
      distinctDecryptFailureMessageIds: 0,
      lastPlaintextInboundAt: null,
      lastDecryptFailureAt: null,
      activeFailureStreak: 0,
      activeFailureDistinctIds: 0,
      failureEpisodeStartedAt: null,
    };
  }

  const cryptoHealth = buildCryptoHealthStatus(counters, {
    socketReady,
    nowMs: opts.nowMs,
  });
  const compatibilityStatus = cryptoHealth.status;
  const compatibilityReason = classifyCompatibility({
    ...counters,
    socketReady,
    nowMs: opts.nowMs,
  }).reason;
  const recommendedRuntimeEngine = recommendRuntimeEngine({
    compatibilityStatus,
    runtimeEngine,
  });

  return {
    ...status,
    runtimeEngine,
    cryptoHealth,
    compatibilityStatus,
    compatibilityReason,
    recommendedRuntimeEngine,
  };
}

module.exports = {
  COMPATIBILITY,
  RUNTIME_ENGINE,
  DEGRADED_MIN_FAILURES,
  DEGRADED_MIN_DISTINCT_IDS,
  EPISODE_MAX_AGE_MS,
  classifyCompatibility,
  recommendRuntimeEngine,
  buildCryptoHealthStatus,
  normalizeV6InboundCapture,
  attachCompatibilityDiagnostics,
  resolveActiveEpisode,
};
