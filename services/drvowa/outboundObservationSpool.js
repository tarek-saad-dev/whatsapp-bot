'use strict';

const fs = require('fs');
const path = require('path');

const STATUS = Object.freeze({
  PENDING: 'pending_delivery',
  UNRESOLVED: 'unresolved',
  DELIVERED: 'delivered',
  FAILED: 'failed',
});

const ORIGIN = Object.freeze({
  DRVOWA_API: 'DRVOWA_API',
  HUMAN_MANUAL: 'HUMAN_MANUAL',
  UNRESOLVED: 'UNRESOLVED',
});

const DEFAULT_MAX_DELIVERED = 500;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function utcNow() {
  return new Date().toISOString();
}

function normalizeOrigin(origin) {
  if (origin === ORIGIN.DRVOWA_API) return ORIGIN.DRVOWA_API;
  if (origin === ORIGIN.UNRESOLVED) return ORIGIN.UNRESOLVED;
  return ORIGIN.HUMAN_MANUAL;
}

function statusForOrigin(origin) {
  if (origin === ORIGIN.UNRESOLVED) return STATUS.UNRESOLVED;
  return STATUS.PENDING;
}

/**
 * Durable managed outbound observation spool (API vs human fromMe).
 * Separate from inbound inbox-spool.json.
 *
 * UNRESOLVED is a local hold only — never delivery-eligible / never POSTed to SaaS.
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
          // Normalize legacy records that may lack UNRESOLVED status.
          if (item.origin === ORIGIN.UNRESOLVED && item.status === STATUS.PENDING) {
            item.status = STATUS.UNRESOLVED;
          }
          records.set(item.providerMessageId, item);
        }
      }
      cleanupDelivered();
    } catch (error) {
      throw new Error(`Failed to load outbound observation spool: ${error.message}`);
    }
  }

  function buildRecord(observation, origin) {
    return {
      providerMessageId: String(observation.providerMessageId).trim(),
      accountKey: String(observation.accountKey || ''),
      status: statusForOrigin(origin),
      origin,
      phone: observation.phone || null,
      externalContactKey: observation.externalContactKey || null,
      occurredAt: observation.occurredAt || utcNow(),
      attempts: 0,
      nextRetryAt: utcNow(),
      lastError: null,
      capturedAt: utcNow(),
      deliveredAt: null,
    };
  }

  /**
   * Capture or promote by providerMessageId.
   * Decisive DRVOWA_API may promote UNRESOLVED → delivery-eligible.
   * Decisive origins never downgrade. HUMAN never silently flips.
   */
  function captureOrPromote(observation) {
    const providerMessageId = String(observation?.providerMessageId || '').trim();
    if (!providerMessageId) {
      throw new Error('capture requires providerMessageId');
    }
    const proposed = normalizeOrigin(observation.origin);
    const existing = records.get(providerMessageId);

    if (!existing) {
      const record = buildRecord({ ...observation, providerMessageId }, proposed);
      records.set(providerMessageId, record);
      persist();
      return {
        record,
        duplicate: false,
        promoted: false,
        conflict: false,
      };
    }

    // Already decisive API — never downgrade.
    if (existing.origin === ORIGIN.DRVOWA_API) {
      return {
        record: existing,
        duplicate: true,
        promoted: false,
        conflict: proposed !== ORIGIN.DRVOWA_API,
      };
    }

    // Promote held UNRESOLVED → decisive API.
    if (
      proposed === ORIGIN.DRVOWA_API
      && (existing.origin === ORIGIN.UNRESOLVED || existing.status === STATUS.UNRESOLVED)
    ) {
      existing.origin = ORIGIN.DRVOWA_API;
      existing.status = STATUS.PENDING;
      existing.nextRetryAt = utcNow();
      existing.lastError = null;
      if (observation.phone && !existing.phone) existing.phone = observation.phone;
      if (observation.externalContactKey && !existing.externalContactKey) {
        existing.externalContactKey = observation.externalContactKey;
      }
      if (observation.occurredAt) existing.occurredAt = observation.occurredAt;
      persist();
      return {
        record: existing,
        duplicate: true,
        promoted: true,
        conflict: false,
      };
    }

    // Promote held UNRESOLVED → decisive HUMAN when observer now has no API ambiguity.
    if (
      proposed === ORIGIN.HUMAN_MANUAL
      && (existing.origin === ORIGIN.UNRESOLVED || existing.status === STATUS.UNRESOLVED)
    ) {
      existing.origin = ORIGIN.HUMAN_MANUAL;
      existing.status = STATUS.PENDING;
      existing.nextRetryAt = utcNow();
      existing.lastError = null;
      if (observation.phone && !existing.phone) existing.phone = observation.phone;
      if (observation.externalContactKey && !existing.externalContactKey) {
        existing.externalContactKey = observation.externalContactKey;
      }
      if (observation.occurredAt) existing.occurredAt = observation.occurredAt;
      persist();
      return {
        record: existing,
        duplicate: true,
        promoted: true,
        conflict: false,
      };
    }

    // Already decisive HUMAN — do not silently flip.
    if (existing.origin === ORIGIN.HUMAN_MANUAL) {
      return {
        record: existing,
        duplicate: true,
        promoted: false,
        conflict: proposed !== ORIGIN.HUMAN_MANUAL,
      };
    }

    // Existing UNRESOLVED + still-ambiguous proposal: keep held.
    return {
      record: existing,
      duplicate: true,
      promoted: false,
      conflict: false,
    };
  }

  function capture(observation) {
    return captureOrPromote(observation);
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
    // Never move UNRESOLVED holds into delivery via retry.
    if (record.status === STATUS.UNRESOLVED || record.origin === ORIGIN.UNRESOLVED) {
      return record;
    }
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
      .filter((r) => r.origin === ORIGIN.DRVOWA_API || r.origin === ORIGIN.HUMAN_MANUAL)
      .filter((r) => new Date(r.nextRetryAt).getTime() <= ts)
      .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  }

  function getStats() {
    let pending = 0;
    let unresolved = 0;
    let delivered = 0;
    let failed = 0;
    let oldestUnresolvedCapturedAt = null;
    for (const record of records.values()) {
      if (record.status === STATUS.DELIVERED) delivered += 1;
      else if (record.status === STATUS.FAILED) failed += 1;
      else if (
        record.status === STATUS.UNRESOLVED
        || record.origin === ORIGIN.UNRESOLVED
      ) {
        unresolved += 1;
        const capturedAt = record.capturedAt || null;
        if (
          capturedAt
          && (!oldestUnresolvedCapturedAt
            || Date.parse(capturedAt) < Date.parse(oldestUnresolvedCapturedAt))
        ) {
          oldestUnresolvedCapturedAt = capturedAt;
        }
      } else pending += 1;
    }
    return {
      pending,
      unresolved,
      delivered,
      failed,
      total: records.size,
      // Accumulation signal only — no silent deletion of UNRESOLVED in this phase.
      oldestUnresolvedCapturedAt,
    };
  }

  function get(providerMessageId) {
    return records.get(String(providerMessageId || '')) || null;
  }

  load();

  return {
    STATUS,
    ORIGIN,
    spoolFile,
    capture,
    captureOrPromote,
    markDelivered,
    markRetry,
    getPendingForDelivery,
    getStats,
    get,
    load,
    persist,
    cleanupDelivered,
  };
}

module.exports = {
  createOutboundObservationSpool,
  STATUS,
  ORIGIN,
};
