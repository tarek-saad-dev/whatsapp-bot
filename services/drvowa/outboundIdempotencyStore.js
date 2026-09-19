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

function utcNow() {
  return new Date().toISOString();
}

function hashPayload({ phone, message }) {
  return crypto
    .createHash('sha256')
    .update(`${String(phone || '')}\0${String(message || '')}`, 'utf8')
    .digest('hex');
}

/**
 * Durable per-account outbound idempotency + API send correlation.
 * File: <authDir>/outbound-idempotency.json
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

  function prune() {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of byKey.entries()) {
      const ts = Date.parse(entry.updatedAt || entry.createdAt || '');
      if (Number.isFinite(ts) && now - ts > retentionMs) {
        byKey.delete(key);
        changed = true;
      }
    }
    if (byKey.size > maxEntries) {
      const sorted = Array.from(byKey.values()).sort(
        (a, b) => Date.parse(a.updatedAt || a.createdAt) - Date.parse(b.updatedAt || b.createdAt),
      );
      const excess = byKey.size - maxEntries;
      for (let i = 0; i < excess; i += 1) {
        byKey.delete(sorted[i].idempotencyKey);
        changed = true;
      }
    }
    if (changed) {
      rebuildProviderIndex();
      persist();
    }
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
    const now = utcNow();
    const entry = {
      idempotencyKey: String(idempotencyKey),
      state: STATES.SENDING,
      providerMessageId: null,
      phone: String(phone || ''),
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

  /**
   * Clear a failed first-attempt reservation so a later distinct retry can proceed.
   * Never clears SENT.
   */
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

  function size() {
    return byKey.size;
  }

  load();

  return {
    STATES,
    filePath,
    hashPayload,
    get,
    reserveSending,
    markSent,
    clearSending,
    isApiOrigin,
    getByProviderMessageId,
    size,
    prune,
    load,
    persist,
  };
}

module.exports = {
  createOutboundIdempotencyStore,
  hashPayload,
  STATES,
};
