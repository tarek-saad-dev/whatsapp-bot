'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATES = Object.freeze({
  SENDING: 'SENDING',
  SENT: 'SENT',
});

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;

const CAPACITY_CODE = 'OUTBOUND_IDEMPOTENCY_CAPACITY';

function utcNow() {
  return new Date().toISOString();
}

function normalizePhoneForHash(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function hashPayload({ phone, message }) {
  return crypto
    .createHash('sha256')
    .update(`${normalizePhoneForHash(phone)}\0${String(message || '')}`, 'utf8')
    .digest('hex');
}

/**
 * Durable per-account outbound idempotency + API send correlation.
 * File: <authDir>/outbound-idempotency.json
 *
 * Hard invariant: unresolved SENDING entries are NEVER pruned by retention
 * or maxEntries eviction. Capacity exhaustion fails closed before send.
 */
function createOutboundIdempotencyStore({
  filePath,
  retentionMs = Number(process.env.DRVOWA_OUTBOUND_IDEMPOTENCY_RETENTION_MS || DEFAULT_RETENTION_MS),
  maxEntries = Number(process.env.DRVOWA_OUTBOUND_IDEMPOTENCY_MAX_ENTRIES || DEFAULT_MAX_ENTRIES),
} = {}) {
  if (!filePath) {
    throw new Error('outbound idempotency store requires filePath');
  }

  /** @type {Map<string, object>} */
  const byKey = new Map();
  /** @type {Map<string, string>} key by providerMessageId */
  const byProviderMessageId = new Map();

  function ensureDir() {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  function persist() {
    ensureDir();
    const tmp = `${filePath}.tmp`;
    const payload = {
      version: 1,
      updatedAt: utcNow(),
      entries: Array.from(byKey.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  function rebuildProviderIndex() {
    byProviderMessageId.clear();
    for (const entry of byKey.values()) {
      if (entry.providerMessageId && entry.state === STATES.SENT) {
        byProviderMessageId.set(String(entry.providerMessageId), entry.idempotencyKey);
      }
    }
  }

  function removeEntry(key) {
    const entry = byKey.get(String(key));
    if (!entry) return false;
    byKey.delete(String(key));
    if (entry.providerMessageId) {
      byProviderMessageId.delete(String(entry.providerMessageId));
    }
    return true;
  }

  function listSentOldestFirst() {
    return Array.from(byKey.values())
      .filter((e) => e.state === STATES.SENT)
      .sort(
        (a, b) => Date.parse(a.updatedAt || a.createdAt || 0)
          - Date.parse(b.updatedAt || b.createdAt || 0),
      );
  }

  function countByState() {
    let sending = 0;
    let sent = 0;
    for (const entry of byKey.values()) {
      if (entry.state === STATES.SENDING) sending += 1;
      else if (entry.state === STATES.SENT) sent += 1;
    }
    return { sending, sent };
  }

  /**
   * Retention + soft capacity trim.
   * - Retention deletes expired SENT only.
   * - Capacity trim deletes oldest SENT only while size > maxEntries.
   * - SENDING is never removed here.
   * - Loaded stores may remain temporarily over maxEntries if only SENDING remains.
   */
  function prune() {
    const now = Date.now();
    let changed = false;

    const expiredSentKeys = [];
    for (const [key, entry] of byKey.entries()) {
      if (entry.state !== STATES.SENT) continue;
      const ts = Date.parse(entry.updatedAt || entry.createdAt || '');
      if (Number.isFinite(ts) && now - ts > retentionMs) {
        expiredSentKeys.push(key);
      }
    }
    for (const key of expiredSentKeys) {
      removeEntry(key);
      changed = true;
    }

    while (byKey.size > maxEntries) {
      const oldestSent = listSentOldestFirst()[0];
      if (!oldestSent) break;
      removeEntry(oldestSent.idempotencyKey);
      changed = true;
    }

    if (changed) {
      rebuildProviderIndex();
      persist();
    }
  }

  /**
   * Ensure one free slot for a NEW reservation.
   * Evicts oldest SENT as needed. Never evicts SENDING.
   * @returns {boolean} true if a new entry may be inserted
   */
  function ensureCapacityForNewReservation() {
    const now = Date.now();
    let changed = false;

    const expiredSentKeys = [];
    for (const [key, entry] of byKey.entries()) {
      if (entry.state !== STATES.SENT) continue;
      const ts = Date.parse(entry.updatedAt || entry.createdAt || '');
      if (Number.isFinite(ts) && now - ts > retentionMs) {
        expiredSentKeys.push(key);
      }
    }
    for (const key of expiredSentKeys) {
      removeEntry(key);
      changed = true;
    }

    while (byKey.size >= maxEntries) {
      const oldestSent = listSentOldestFirst()[0];
      if (!oldestSent) {
        if (changed) {
          rebuildProviderIndex();
          persist();
        }
        return false;
      }
      removeEntry(oldestSent.idempotencyKey);
      changed = true;
    }

    if (changed) {
      rebuildProviderIndex();
      persist();
    }
    return true;
  }

  function load() {
    ensureDir();
    byKey.clear();
    byProviderMessageId.clear();
    if (!fs.existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const entry of parsed.entries || []) {
        if (!entry || !entry.idempotencyKey) continue;
        byKey.set(String(entry.idempotencyKey), entry);
      }
      rebuildProviderIndex();
      prune();
    } catch (error) {
      throw new Error(`Failed to load outbound idempotency store: ${error.message}`);
    }
  }

  function get(idempotencyKey) {
    return byKey.get(String(idempotencyKey)) || null;
  }

  function reserveSending({ idempotencyKey, phone, payloadHash }) {
    const key = String(idempotencyKey);
    const existing = byKey.get(key);
    if (existing) {
      const err = new Error(
        existing.state === STATES.SENDING
          ? 'Outbound idempotency key already has an unresolved SENDING reservation'
          : 'Outbound idempotency key already exists',
      );
      err.code = 'OUTBOUND_IDEMPOTENCY_RESERVE_CONFLICT';
      err.existingState = existing.state;
      throw err;
    }

    if (!ensureCapacityForNewReservation()) {
      const err = new Error(
        'Outbound idempotency store is at capacity with unresolved SENDING reservations',
      );
      err.code = CAPACITY_CODE;
      err.sendAttempted = false;
      err.outcomeUnknown = false;
      throw err;
    }

    const now = utcNow();
    const entry = {
      idempotencyKey: key,
      state: STATES.SENDING,
      providerMessageId: null,
      phone: normalizePhoneForHash(phone),
      payloadHash: String(payloadHash || ''),
      origin: 'DRVOWA_API',
      createdAt: now,
      updatedAt: now,
    };
    byKey.set(entry.idempotencyKey, entry);
    persist();
    return entry;
  }

  function markSent({ idempotencyKey, providerMessageId }) {
    const entry = byKey.get(String(idempotencyKey));
    if (!entry) return null;
    entry.state = STATES.SENT;
    entry.providerMessageId = providerMessageId ? String(providerMessageId) : null;
    entry.updatedAt = utcNow();
    if (entry.providerMessageId) {
      byProviderMessageId.set(entry.providerMessageId, entry.idempotencyKey);
    }
    persist();
    prune();
    return entry;
  }

  function clearSending(idempotencyKey) {
    const entry = byKey.get(String(idempotencyKey));
    if (!entry || entry.state !== STATES.SENDING) return false;
    byKey.delete(String(idempotencyKey));
    persist();
    return true;
  }

  function isApiOrigin(providerMessageId) {
    if (!providerMessageId) return false;
    return byProviderMessageId.has(String(providerMessageId));
  }

  function getByProviderMessageId(providerMessageId) {
    const key = byProviderMessageId.get(String(providerMessageId));
    if (!key) return null;
    return byKey.get(key) || null;
  }

  function findSendingByPhoneAndHash({ phone, payloadHash }) {
    const normalized = normalizePhoneForHash(phone);
    const hash = String(payloadHash || '');
    const matches = [];
    for (const entry of byKey.values()) {
      if (entry.state !== STATES.SENDING) continue;
      if (normalizePhoneForHash(entry.phone) !== normalized) continue;
      if (String(entry.payloadHash || '') !== hash) continue;
      matches.push(entry);
    }
    return matches;
  }

  function reconcileSendingFromObservation({ phone, text, providerMessageId }) {
    const pid = providerMessageId ? String(providerMessageId) : '';
    if (!pid) {
      return { reconciled: false, reason: 'missing_provider_message_id', matchCount: 0 };
    }
    if (byProviderMessageId.has(pid)) {
      return {
        reconciled: false,
        reason: 'already_correlated',
        matchCount: 0,
        idempotencyKey: byProviderMessageId.get(pid),
      };
    }
    const payloadHash = hashPayload({ phone, message: text || '' });
    const matches = findSendingByPhoneAndHash({ phone, payloadHash });
    if (matches.length === 0) {
      return { reconciled: false, reason: 'no_match', matchCount: 0 };
    }
    if (matches.length > 1) {
      return { reconciled: false, reason: 'ambiguous_match', matchCount: matches.length };
    }
    const entry = matches[0];
    markSent({
      idempotencyKey: entry.idempotencyKey,
      providerMessageId: pid,
    });
    return {
      reconciled: true,
      reason: 'matched',
      matchCount: 1,
      idempotencyKey: entry.idempotencyKey,
      entry: byKey.get(entry.idempotencyKey),
    };
  }

  function size() {
    return byKey.size;
  }

  function getStats() {
    const { sending, sent } = countByState();
    const total = byKey.size;
    return {
      total,
      sending,
      sent,
      maxEntries,
      saturated: total >= maxEntries && sent === 0,
    };
  }

  function dumpEntries() {
    return Array.from(byKey.values()).map((e) => ({ ...e }));
  }

  load();

  return {
    STATES,
    filePath,
    hashPayload,
    normalizePhoneForHash,
    get,
    reserveSending,
    markSent,
    clearSending,
    isApiOrigin,
    getByProviderMessageId,
    findSendingByPhoneAndHash,
    reconcileSendingFromObservation,
    ensureCapacityForNewReservation,
    size,
    getStats,
    prune,
    load,
    persist,
    dumpEntries,
  };
}

module.exports = {
  createOutboundIdempotencyStore,
  hashPayload,
  normalizePhoneForHash,
  STATES,
  CAPACITY_CODE,
};