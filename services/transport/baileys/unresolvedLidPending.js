'use strict';

/**
 * Bounded pending buffer for inbound messages awaiting LID mapping or decrypt retry.
 * Supports scheduled resolve retries (not a tight loop) and timeout quarantine.
 */

function createUnresolvedLidPendingBuffer({
  timeoutMs = Number(process.env.BAILEYS_LID_PENDING_MS || 8000),
  maxEntries = Number(process.env.BAILEYS_LID_PENDING_MAX || 100),
  /** Retry offsets in ms within the pending window (active resolve attempts). */
  retryOffsetsMs = (process.env.BAILEYS_LID_RETRY_OFFSETS_MS || '0,1000,3000,6000')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n >= 0),
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const entries = new Map(); // messageId -> { msg, upsertType, reason, enqueuedAt, timer, retryTimers }

  function size() {
    return entries.size;
  }

  function has(messageId) {
    return entries.has(String(messageId || ''));
  }

  function clearRetryTimers(entry) {
    for (const t of entry.retryTimers || []) {
      try { clearTimer(t); } catch (_) { /* ignore */ }
    }
    entry.retryTimers = [];
  }

  function enqueue(messageId, payload, { onTimeout, onRetry } = {}) {
    const id = String(messageId || '').trim();
    if (!id) return { ok: false, reason: 'missing_message_id' };
    if (entries.has(id)) return { ok: true, duplicate: true };

    if (entries.size >= maxEntries) {
      return { ok: false, reason: 'pending_buffer_full' };
    }

    const entry = {
      msg: payload.msg,
      upsertType: payload.upsertType || 'notify',
      reason: payload.reason || 'unresolved_lid',
      enqueuedAt: now(),
      timer: null,
      retryTimers: [],
    };

    entry.timer = setTimer(() => {
      const current = entries.get(id);
      if (!current) return;
      clearRetryTimers(current);
      entries.delete(id);
      try {
        if (typeof onTimeout === 'function') onTimeout(current);
      } catch (_) {
        // never throw from timer
      }
    }, Math.max(0, timeoutMs));

    if (typeof onRetry === 'function') {
      const offsets = retryOffsetsMs.length ? retryOffsetsMs : [0];
      for (const offset of offsets) {
        if (offset >= timeoutMs) continue;
        const t = setTimer(() => {
          const current = entries.get(id);
          if (!current) return;
          try {
            onRetry(current);
          } catch (_) {
            // never throw from timer
          }
        }, offset);
        entry.retryTimers.push(t);
      }
    }

    entries.set(id, entry);
    return { ok: true, duplicate: false };
  }

  function take(messageId) {
    const id = String(messageId || '').trim();
    const entry = entries.get(id);
    if (!entry) return null;
    clearTimer(entry.timer);
    clearRetryTimers(entry);
    entries.delete(id);
    return entry;
  }

  function drainAll() {
    const out = [];
    for (const [id, entry] of entries.entries()) {
      clearTimer(entry.timer);
      clearRetryTimers(entry);
      out.push({ messageId: id, ...entry });
    }
    entries.clear();
    return out;
  }

  function list() {
    return Array.from(entries.entries()).map(([messageId, entry]) => ({
      messageId,
      upsertType: entry.upsertType,
      reason: entry.reason,
      enqueuedAt: entry.enqueuedAt,
      msg: entry.msg,
    }));
  }

  function clear() {
    for (const entry of entries.values()) {
      clearTimer(entry.timer);
      clearRetryTimers(entry);
    }
    entries.clear();
  }

  return {
    timeoutMs,
    maxEntries,
    retryOffsetsMs,
    size,
    has,
    enqueue,
    take,
    drainAll,
    list,
    clear,
  };
}

module.exports = {
  createUnresolvedLidPendingBuffer,
};
