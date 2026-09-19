'use strict';

const fs = require('fs');
const path = require('path');

const STATUS = Object.freeze({
  PENDING: 'pending_delivery',
  DELIVERED: 'delivered',
  FAILED: 'failed',
});

const DEFAULT_MAX_DELIVERED = 500;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function utcNow() {
  return new Date().toISOString();
}

/**
 * Durable managed outbound observation spool (API vs human fromMe).
 * Separate from inbound inbox-spool.json.
 */
function createOutboundObservationSpool({
  spoolFile,
  maxDelivered = Number(process.env.DRVOWA_OUTBOUND_OBS_SPOOL_MAX_DELIVERED || DEFAULT_MAX_DELIVERED),
  retentionMs = Number(
    process.env.DRVOWA_OUTBOUND_OBS_SPOOL_RETENTION_MS || DEFAULT_RETENTION_MS,
  ),
} = {}) {
  if (!spoolFile) {
    throw new Error('outbound observation spool requires spoolFile');
  }

  const records = new Map();

  function ensureDir() {
    const dir = path.dirname(spoolFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  function persist() {
    ensureDir();
    const tmp = `${spoolFile}.tmp`;
    const payload = {
      version: 1,
      updatedAt: utcNow(),
      records: Array.from(records.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, spoolFile);
  }

  function cleanupDelivered() {
    const now = Date.now();
    let changed = false;
    for (const [id, record] of records.entries()) {
      if (record.status !== STATUS.DELIVERED) continue;
      if (!record.deliveredAt) continue;
      if (now - Date.parse(record.deliveredAt) > retentionMs) {
        records.delete(id);
        changed = true;
      }
    }
    const delivered = Array.from(records.values())
      .filter((r) => r.status === STATUS.DELIVERED)
      .sort((a, b) => new Date(a.deliveredAt) - new Date(b.deliveredAt));
    if (delivered.length > maxDelivered) {
      const excess = delivered.length - maxDelivered;
      for (let i = 0; i < excess; i += 1) {
        records.delete(delivered[i].providerMessageId);
        changed = true;
      }
    }
    if (changed) persist();
  }

  function load() {
    ensureDir();
    records.clear();
    if (!fs.existsSync(spoolFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(spoolFile, 'utf8'));
      for (const item of parsed.records || []) {
        if (item && item.providerMessageId) {
          records.set(item.providerMessageId, item);
        }
      }
      cleanupDelivered();
    } catch (error) {
      throw new Error(`Failed to load outbound observation spool: ${error.message}`);
    }
  }

  function capture(observation) {
    const providerMessageId = String(observation?.providerMessageId || '').trim();
    if (!providerMessageId) {
      throw new Error('capture requires providerMessageId');
    }
    if (records.has(providerMessageId)) {
      return { record: records.get(providerMessageId), duplicate: true };
    }
    const record = {
      providerMessageId,
      accountKey: String(observation.accountKey || ''),
      status: STATUS.PENDING,
      origin: observation.origin === 'DRVOWA_API' ? 'DRVOWA_API' : 'HUMAN_MANUAL',
      phone: observation.phone || null,
      externalContactKey: observation.externalContactKey || null,
      occurredAt: observation.occurredAt || utcNow(),
      attempts: 0,
      nextRetryAt: utcNow(),
      lastError: null,
      capturedAt: utcNow(),
      deliveredAt: null,
    };
    records.set(providerMessageId, record);
    persist();
    return { record, duplicate: false };
  }

  function markDelivered(providerMessageId) {
    const record = records.get(providerMessageId);
    if (!record) return null;
    record.status = STATUS.DELIVERED;
    record.deliveredAt = utcNow();
    record.lastError = null;
    persist();
    cleanupDelivered();
    return record;
  }

  function markRetry(providerMessageId, { nextRetryAt, error } = {}) {
    const record = records.get(providerMessageId);
    if (!record) return null;
    record.attempts += 1;
    record.lastError = error || null;
    record.nextRetryAt = nextRetryAt || utcNow();
    record.status = STATUS.PENDING;
    persist();
    return record;
  }

  function getPendingForDelivery(now = new Date()) {
    const ts = now.getTime();
    return Array.from(records.values())
      .filter((r) => r.status === STATUS.PENDING)
      .filter((r) => new Date(r.nextRetryAt).getTime() <= ts)
      .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  }

  function getStats() {
    let pending = 0;
    let delivered = 0;
    let failed = 0;
    for (const record of records.values()) {
      if (record.status === STATUS.DELIVERED) delivered += 1;
      else if (record.status === STATUS.FAILED) failed += 1;
      else pending += 1;
    }
    return { pending, delivered, failed, total: records.size };
  }

  load();

  return {
    STATUS,
    spoolFile,
    capture,
    markDelivered,
    markRetry,
    getPendingForDelivery,
    getStats,
    load,
    persist,
    cleanupDelivered,
  };
}

module.exports = {
  createOutboundObservationSpool,
  STATUS,
};
