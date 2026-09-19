'use strict';

const crypto = require('crypto');

const STATES = Object.freeze({
  NORMAL: 'NORMAL',
  CAUTION: 'CAUTION',
  COOLDOWN: 'COOLDOWN',
  PAUSED: 'PAUSED',
});

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

function contentHash(phone, message) {
  return crypto
    .createHash('sha256')
    .update(`${normalizePhone(phone)}\0${String(message || '')}`, 'utf8')
    .digest('hex');
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
  /** @type {number[]} */
  const sendTimestamps = [];
  /** @type {Map<string, number[]>} phone -> timestamps */
  const destTimestamps = new Map();
  /** @type {Map<string, number[]>} hash -> timestamps */
  const contentTimestamps = new Map();

  function pruneList(list, windowMs, t) {
    while (list.length && t - list[0] > windowMs) list.shift();
  }

  function refreshState(t) {
    if (paused) {
      state = STATES.PAUSED;
      return;
    }
    if (cooldownUntil > t) {
      state = STATES.COOLDOWN;
      return;
    }
    pruneList(sendTimestamps, 60 * 1000, t);
    const cautionMinute = Math.max(1, Math.floor(cfg.perMinute * 0.8));
    const cautionBurst = Math.max(1, Math.floor(cfg.burstLimit * 0.75));
    if (sendTimestamps.length >= cautionMinute
      || sendTimestamps.filter((x) => t - x <= cfg.burstWindowMs).length
        >= cautionBurst) {
      state = STATES.CAUTION;
      return;
    }
    state = STATES.NORMAL;
  }

  function countInWindow(list, windowMs, t) {
    pruneList(list, windowMs, t);
    return list.length;
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

    const minuteCount = countInWindow(sendTimestamps, 60 * 1000, t);
    const hourCount = countInWindow(sendTimestamps, 60 * 60 * 1000, t);
    const dayCount = countInWindow(sendTimestamps, 24 * 60 * 60 * 1000, t);
    const burstCount = countInWindow(sendTimestamps, cfg.burstWindowMs, t);

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
      const destList = destTimestamps.get(dest) || [];
      pruneList(destList, 60 * 60 * 1000, t);
      // Fan-out: count unique destinations touched this hour
      let uniqueHour = 0;
      for (const [p, stamps] of destTimestamps.entries()) {
        pruneList(stamps, 60 * 60 * 1000, t);
        if (stamps.length) uniqueHour += 1;
        else destTimestamps.delete(p);
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

    const hash = contentHash(phone, message);
    const cList = contentTimestamps.get(hash) || [];
    pruneList(cList, cfg.repeatedContentWindowMs, t);
    if (cList.length >= cfg.repeatedContentLimit) {
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
    const hash = contentHash(phone, message);
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
      minuteCount: countInWindow(sendTimestamps, 60 * 1000, t),
      hourCount: countInWindow(sendTimestamps, 60 * 60 * 1000, t),
      dayCount: countInWindow(sendTimestamps, 24 * 60 * 60 * 1000, t),
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
  };
}

module.exports = {
  createOutboundNumberSafety,
  STATES,
  DEFAULTS,
};
