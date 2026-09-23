'use strict';

/**
 * Bounded pending buffer for inbound @lid messages that lack a PN mapping yet.
 * When a mapping arrives shortly after, the message is reprocessed.
 * On timeout the message is quarantined (never silently dropped).
 */

function createUnresolvedLidPendingBuffer({
  timeoutMs = Number(process.env.BAILEYS_LID_PENDING_MS || 8000),
  maxEntries = Number(process.env.BAILEYS_LID_PENDING_MAX || 100),
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const entries = new Map(); // messageId -> { msg, upsertType, enqueuedAt, timer }

  function size() {
    return entries.size;
  }

  function has(messageId) {
    return entries.has(String(messageId || ''));
  }

  function enqueue(messageId, payload, onTimeout) {
    const id = String(messageId || '').trim();
    if (!id) return { ok: false, reason: 'missing_message_id' };
    if (entries.has(id)) return { ok: true, duplicate: true };

    if (entries.size >= maxEntries) {
      return { ok: false, reason: 'pending_buffer_full' };
    }

    const timer = setTimer(() => {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id);
      try {
        onTimeout(entry);
      } catch (_) {
        // never throw from timer
      }
    }, Math.max(0, timeoutMs));

    entries.set(id, {
      msg: payload.msg,
      upsertType: payload.upsertType || 'notify',
      enqueuedAt: now(),
      timer,
    });
    return { ok: true, duplicate: false };
  }

  function take(messageId) {
    const id = String(messageId || '').trim();
    const entry = entries.get(id);
    if (!entry) return null;
    clearTimer(entry.timer);
    entries.delete(id);
    return entry;
  }

  function drainAll() {
    const out = [];
    for (const [id, entry] of entries.entries()) {
      clearTimer(entry.timer);
      out.push({ messageId: id, ...entry });
    }
    entries.clear();
    return out;
  }

  /** Snapshot of pending entries without removing (for reprocess attempts). */
  function list() {
    return Array.from(entries.entries()).map(([messageId, entry]) => ({
      messageId,
      upsertType: entry.upsertType,
      enqueuedAt: entry.enqueuedAt,
      msg: entry.msg,
    }));
  }

  function clear() {
    for (const entry of entries.values()) {
      clearTimer(entry.timer);
    }
    entries.clear();
  }

  return {
    timeoutMs,
    maxEntries,
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
