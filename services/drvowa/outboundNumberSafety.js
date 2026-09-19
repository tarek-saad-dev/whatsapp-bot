'use strict';

const crypto = require('crypto');

const STATES = Object.freeze({
  NORMAL: 'NORMAL',
  CAUTION: 'CAUTION',
  COOLDOWN: 'COOLDOWN',
  PAUSED: 'PAUSED',
});

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = Object.freeze({
  perMinute: 20,
  perHour: 120,
  perDay: 500,
  burstLimit: 8,
  burstWindowMs: 10_000,
  fanOutUniquePerHour: 40,
  repeatedContentLimit: 5,
  repeatedContentWindowMs: 60 * 60 * 1000,
  cautionCooldownMs: 30_000,
  cooldownMs: 5 * 60 * 1000,
});

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Content-only fingerprint (no phone). Never log or expose this hash. */
function contentHash(message) {
  return crypto
    .createHash('sha256')
    .update(String(message || ''), 'utf8')
    .digest('hex');
}

/**
 * Count timestamps within windowMs of t without mutating the list.
 * Assumes list is sorted ascending.
 */
function countWithin(list, windowMs, t) {
  if (!list || !list.length) return 0;
  let count = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (t - list[i] > windowMs) break;
    count += 1;
  }
  return count;
}

/** Destructively drop entries older than windowMs (oldest-first sorted lists). */
function pruneList(list, windowMs, t) {
  while (list.length && t - list[0] > windowMs) list.shift();
}

/**
 * Per-account outbound admission control.
 * One instance MUST be created per managed provider lifecycle (not per send).
 *
 * Does not claim customer-initiated prioritization — expose checkInboundHook later.
 */
function createOutboundNumberSafety({
  accountKey,
  now = () => Date.now(),
  limits = {},
} = {}) {
  if (!accountKey) {
    throw new Error('accountKey is required for outbound number safety');
  }

  const cfg = { ...DEFAULTS, ...limits };
  let paused = false;
  let state = STATES.NORMAL;
  let cooldownUntil = 0;
  /** @type {number[]} retained for DAY_MS */
  const sendTimestamps = [];
  /** @type {Map<string, number[]>} phone -> timestamps */
  const destTimestamps = new Map();
  /** @type {Map<string, number[]>} content-hash -> timestamps */
  const contentTimestamps = new Map();

  function pruneSendRetention(t) {
    pruneList(sendTimestamps, DAY_MS, t);
  }

  function pruneDestinations(t) {
    for (const [p, stamps] of destTimestamps.entries()) {
      pruneList(stamps, HOUR_MS, t);
      if (!stamps.length) destTimestamps.delete(p);
    }
  }

  function pruneContentFingerprints(t) {
    for (const [hash, stamps] of contentTimestamps.entries()) {
      pruneList(stamps, cfg.repeatedContentWindowMs, t);
      if (!stamps.length) contentTimestamps.delete(hash);
    }
  }

  function pruneAll(t) {
    pruneSendRetention(t);
    pruneDestinations(t);
    pruneContentFingerprints(t);
  }

  function refreshState(t) {
    pruneAll(t);
    if (paused) {
      state = STATES.PAUSED;
      return;
    }
    if (cooldownUntil > t) {
      state = STATES.COOLDOWN;
      return;
    }
    const cautionMinute = Math.max(1, Math.floor(cfg.perMinute * 0.8));
    const cautionBurst = Math.max(1, Math.floor(cfg.burstLimit * 0.75));
    const minuteCount = countWithin(sendTimestamps, MINUTE_MS, t);
    const burstCount = countWithin(sendTimestamps, cfg.burstWindowMs, t);
    if (minuteCount >= cautionMinute || burstCount >= cautionBurst) {
      state = STATES.CAUTION;
      return;
    }
    state = STATES.NORMAL;
  }

  function enterCooldown(t, ms) {
    cooldownUntil = Math.max(cooldownUntil, t + ms);
    state = STATES.COOLDOWN;
  }

  /**
   * Admission for a NEW outbound send only.
   * Callers must skip this for SENT duplicate replay and SENDING unknown.
   */
  function check({ phone, message } = {}) {
    const t = now();
    refreshState(t);

    if (paused || state === STATES.PAUSED) {
      return {
        allowed: false,
        code: 'OUTBOUND_NUMBER_SAFETY',
        reason: 'paused',
        state: STATES.PAUSED,
      };
    }

    if (cooldownUntil > t) {
      return {
        allowed: false,
        code: 'OUTBOUND_NUMBER_SAFETY',
        reason: 'cooldown',
        state: STATES.COOLDOWN,
        cooldownUntil: new Date(cooldownUntil).toISOString(),
      };
    }

    const minuteCount = countWithin(sendTimestamps, MINUTE_MS, t);
    const hourCount = countWithin(sendTimestamps, HOUR_MS, t);
    const dayCount = countWithin(sendTimestamps, DAY_MS, t);
    const burstCount = countWithin(sendTimestamps, cfg.burstWindowMs, t);

    if (minuteCount >= cfg.perMinute
      || hourCount >= cfg.perHour
      || dayCount >= cfg.perDay
      || burstCount >= cfg.burstLimit) {
      enterCooldown(t, cfg.cooldownMs);
      return {
        allowed: false,
        code: 'OUTBOUND_NUMBER_SAFETY',
        reason: 'rate_limit',
        state: STATES.COOLDOWN,
        cooldownUntil: new Date(cooldownUntil).toISOString(),
      };
    }

    const dest = normalizePhone(phone);
    if (dest) {
      // Fan-out: count unique destinations touched this hour (after pruneDestinations).
      let uniqueHour = 0;
      for (const stamps of destTimestamps.values()) {
        if (countWithin(stamps, HOUR_MS, t) > 0) uniqueHour += 1;
      }
      if (!destTimestamps.has(dest) && uniqueHour >= cfg.fanOutUniquePerHour) {
        enterCooldown(t, cfg.cooldownMs);
        return {
          allowed: false,
          code: 'OUTBOUND_NUMBER_SAFETY',
          reason: 'fan_out',
          state: STATES.COOLDOWN,
          cooldownUntil: new Date(cooldownUntil).toISOString(),
        };
      }
    }

    const hash = contentHash(message);
    const cList = contentTimestamps.get(hash) || [];
    const contentCount = countWithin(cList, cfg.repeatedContentWindowMs, t);
    if (contentCount >= cfg.repeatedContentLimit) {
      enterCooldown(t, cfg.cautionCooldownMs);
      return {
        allowed: false,
        code: 'OUTBOUND_NUMBER_SAFETY',
        reason: 'repeated_content',
        state: STATES.COOLDOWN,
        cooldownUntil: new Date(cooldownUntil).toISOString(),
      };
    }

    return { allowed: true, state, reason: 'ok' };
  }

  /** Record a NEW transport send exposure (call once per sendFn invocation). */
  function recordAttempt({ phone, message } = {}) {
    const t = now();
    sendTimestamps.push(t);
    const dest = normalizePhone(phone);
    if (dest) {
      const list = destTimestamps.get(dest) || [];
      list.push(t);
      destTimestamps.set(dest, list);
    }
    const hash = contentHash(message);
    const cList = contentTimestamps.get(hash) || [];
    cList.push(t);
    contentTimestamps.set(hash, cList);
    refreshState(t);
  }

  /** @deprecated alias — prefer recordAttempt */
  function recordSend(args) {
    return recordAttempt(args);
  }

  function pause() {
    paused = true;
    state = STATES.PAUSED;
  }

  function resume() {
    paused = false;
    cooldownUntil = 0;
    refreshState(now());
  }

  function getStatus() {
    const t = now();
    refreshState(t);
    return {
      accountKey,
      state,
      cooldownUntil: cooldownUntil > t ? new Date(cooldownUntil).toISOString() : null,
      minuteCount: countWithin(sendTimestamps, MINUTE_MS, t),
      hourCount: countWithin(sendTimestamps, HOUR_MS, t),
      dayCount: countWithin(sendTimestamps, DAY_MS, t),
    };
  }

  /**
   * Test-safe introspection: counts only, never hashes or plaintext.
   * Not included in production getStatus().
   */
  function getInternalStats() {
    const t = now();
    pruneAll(t);
    return {
      sendTimestampCount: sendTimestamps.length,
      destinationEntryCount: destTimestamps.size,
      contentFingerprintCount: contentTimestamps.size,
    };
  }

  return {
    STATES,
    check,
    recordAttempt,
    recordSend,
    pause,
    resume,
    getStatus,
    getInternalStats,
  };
}

module.exports = {
  createOutboundNumberSafety,
  STATES,
  DEFAULTS,
  countWithin,
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
};
