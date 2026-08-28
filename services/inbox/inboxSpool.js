'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { utcNow } = require('./inboxTiming');

const DEFAULT_SPOOL_DIR = path.join(process.cwd(), 'data');
const SPOOL_FILE = process.env.WHATSAPP_INBOX_SPOOL_FILE
    || path.join(process.env.DATA_DIR || DEFAULT_SPOOL_DIR, 'inbox-spool.json');
const MAX_DELIVERED = Number(process.env.WHATSAPP_INBOX_SPOOL_MAX_DELIVERED || 500);
const DELIVERED_RETENTION_MS = Number(
    process.env.WHATSAPP_INBOX_SPOOL_DELIVERED_RETENTION_MS || 7 * 24 * 60 * 60 * 1000,
);

const STATUS = {
    PENDING: 'pending_delivery',
    DELIVERED: 'delivered',
    FAILED: 'failed',
};

function createInboxSpool({ spoolFile = SPOOL_FILE } = {}) {
    const records = new Map();
    let cleanupScheduled = false;

    function ensureDir() {
        const dir = path.dirname(spoolFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    function load() {
        ensureDir();
        if (!fs.existsSync(spoolFile)) {
            records.clear();
            return;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(spoolFile, 'utf8'));
            records.clear();
            for (const item of parsed.records || []) {
                if (item && item.providerMessageId) {
                    records.set(item.providerMessageId, item);
                }
            }
        } catch (error) {
            throw new Error(`Failed to load inbox spool: ${error.message}`);
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
            if (now - Date.parse(record.deliveredAt) > DELIVERED_RETENTION_MS) {
                records.delete(id);
                changed = true;
            }
        }

        const delivered = Array.from(records.values())
            .filter((record) => record.status === STATUS.DELIVERED)
            .sort((a, b) => new Date(a.deliveredAt) - new Date(b.deliveredAt));

        if (delivered.length > MAX_DELIVERED) {
            const excess = delivered.length - MAX_DELIVERED;
            for (let i = 0; i < excess; i += 1) {
                records.delete(delivered[i].providerMessageId);
                changed = true;
            }
        }

        if (changed) persist();
    }

    function scheduleCleanupDelivered() {
        if (cleanupScheduled) return;
        cleanupScheduled = true;
        setImmediate(() => {
            cleanupScheduled = false;
            try {
                cleanupDelivered();
            } catch (_) {
                /* ignore background cleanup errors */
            }
        });
    }

    function getRecord(providerMessageId) {
        return records.get(providerMessageId) || null;
    }

    function hasProviderMessageId(providerMessageId) {
        return records.has(providerMessageId);
    }

    function capture(normalizedEvent, { timing = null } = {}) {
        if (!normalizedEvent || !normalizedEvent.providerMessageId) {
            throw new Error('capture requires normalizedEvent.providerMessageId');
        }
        if (records.has(normalizedEvent.providerMessageId)) {
            return records.get(normalizedEvent.providerMessageId);
        }

        const record = {
            providerMessageId: normalizedEvent.providerMessageId,
            status: STATUS.PENDING,
            normalizedEvent,
            timing: timing ? { ...timing } : null,
            attempts: 0,
            nextRetryAt: utcNow(),
            lastError: null,
            capturedAt: utcNow(),
            deliveredAt: null,
        };

        records.set(record.providerMessageId, record);
        const writeStarted = performance.now();
        persist();
        if (record.timing) {
            record.timing.spoolPersistedAt = utcNow();
            record.timing.spoolWriteMs = Math.round(performance.now() - writeStarted);
        }
        return record;
    }

    function updateTiming(providerMessageId, patch) {
        const record = records.get(providerMessageId);
        if (!record) return null;
        record.timing = { ...(record.timing || {}), ...patch };
        return record;
    }

    function markDelivered(providerMessageId) {
        const record = records.get(providerMessageId);
        if (!record) return null;
        record.status = STATUS.DELIVERED;
        record.deliveredAt = utcNow();
        record.lastError = null;
        persist();
        scheduleCleanupDelivered();
        return record;
    }

    function markRetry(providerMessageId, { nextRetryAt, error, permanent = false } = {}) {
        const record = records.get(providerMessageId);
        if (!record) return null;
        record.attempts += 1;
        record.lastError = error || null;
        record.nextRetryAt = nextRetryAt || utcNow();
        record.status = permanent ? STATUS.FAILED : STATUS.PENDING;
        persist();
        return record;
    }

    function markQuarantined(providerMessageId, { reason, errors = [] } = {}) {
        const record = records.get(providerMessageId);
        if (!record) return null;
        record.status = STATUS.FAILED;
        record.lastError = reason || errors.join(',') || 'quarantined';
        record.quarantinedAt = utcNow();
        record.quarantineErrors = errors;
        persist();
        return record;
    }

    function getPendingForDelivery(now = new Date()) {
        const ts = now.getTime();
        return Array.from(records.values())
            .filter((record) => record.status === STATUS.PENDING)
            .filter((record) => new Date(record.nextRetryAt).getTime() <= ts)
            .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    }

    function getStats() {
        let pending = 0;
        let delivered = 0;
        let failedOrRetrying = 0;
        for (const record of records.values()) {
            if (record.status === STATUS.DELIVERED) delivered += 1;
            else if (record.status === STATUS.FAILED) failedOrRetrying += 1;
            else pending += 1;
        }
        return { pending, delivered, failedOrRetrying };
    }

    function listRecent(limit = 50) {
        return Array.from(records.values())
            .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))
            .slice(0, limit)
            .map((record) => ({
                ...record.normalizedEvent,
                deliveryStatus: record.status,
                capturedAt: record.capturedAt,
                deliveredAt: record.deliveredAt,
                timing: record.timing || null,
            }));
    }

    load();

    return {
        STATUS,
        spoolFile,
        load,
        persist,
        cleanupDelivered,
        hasProviderMessageId,
        getRecord,
        capture,
        updateTiming,
        markDelivered,
        markRetry,
        markQuarantined,
        getPendingForDelivery,
        getStats,
        listRecent,
    };
}

module.exports = {
    createInboxSpool,
    STATUS: {
        PENDING: 'pending_delivery',
        DELIVERED: 'delivered',
        FAILED: 'failed',
    },
};
