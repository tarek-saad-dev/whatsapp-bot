'use strict';

const { STATUSES } = require('./constants');

function nowDate(now) {
    return now instanceof Date ? now : new Date();
}

function cloneRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        idempotencyKey: row.idempotencyKey,
        requestHash: row.requestHash,
        phone: row.phone,
        status: row.status,
        providerMessageId: row.providerMessageId,
        attemptCount: row.attemptCount,
        lastError: row.lastError,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        sentAt: row.sentAt,
    };
}

function createMemoryDeliveryStore() {
    const rows = new Map();
    const tails = new Map();
    let nextId = 1;

    function withKeyLock(key, fn) {
        const prev = tails.get(key) || Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        tails.set(key, prev.then(() => gate));
        return prev.then(() => fn()).finally(() => release());
    }

    return {
        kind: 'memory',

        async insertClaim({ key, hash, phone, now }) {
            return withKeyLock(key, async () => {
                if (rows.has(key)) {
                    return { inserted: false };
                }
                const createdAt = nowDate(now);
                const row = {
                    id: nextId++,
                    idempotencyKey: key,
                    requestHash: hash,
                    phone,
                    status: STATUSES.PROCESSING,
                    providerMessageId: null,
                    attemptCount: 1,
                    lastError: null,
                    createdAt,
                    updatedAt: null,
                    sentAt: null,
                };
                rows.set(key, row);
                return { inserted: true, row: cloneRow(row) };
            });
        },

        async getByKey(key) {
            return cloneRow(rows.get(key) || null);
        },

        async claimRetryableFailed(key, now) {
            return withKeyLock(key, async () => {
                const row = rows.get(key);
                if (!row || row.status !== STATUSES.RETRYABLE_FAILED) {
                    return { claimed: false, row: cloneRow(row) };
                }
                row.status = STATUSES.PROCESSING;
                row.attemptCount += 1;
                row.updatedAt = nowDate(now);
                row.lastError = null;
                return { claimed: true, row: cloneRow(row) };
            });
        },

        async markSent(key, providerMessageId, now) {
            return withKeyLock(key, async () => {
                const row = rows.get(key);
                if (!row || row.status !== STATUSES.PROCESSING) {
                    return { updated: false, row: cloneRow(row) };
                }
                const at = nowDate(now);
                row.status = STATUSES.SENT;
                row.providerMessageId = providerMessageId;
                row.sentAt = at;
                row.updatedAt = at;
                row.lastError = null;
                return { updated: true, row: cloneRow(row) };
            });
        },

        async markRetryableFailed(key, lastError, now) {
            return withKeyLock(key, async () => {
                const row = rows.get(key);
                if (!row || row.status !== STATUSES.PROCESSING) {
                    return { updated: false, row: cloneRow(row) };
                }
                row.status = STATUSES.RETRYABLE_FAILED;
                row.lastError = lastError || null;
                row.updatedAt = nowDate(now);
                return { updated: true, row: cloneRow(row) };
            });
        },

        async markUnknown(key, lastError, now) {
            return withKeyLock(key, async () => {
                const row = rows.get(key);
                if (!row) {
                    return { updated: false, row: null };
                }
                if (row.status === STATUSES.SENT) {
                    return { updated: false, row: cloneRow(row) };
                }
                row.status = STATUSES.UNKNOWN;
                row.lastError = lastError || null;
                row.updatedAt = nowDate(now);
                return { updated: true, row: cloneRow(row) };
            });
        },

        async deleteByKey(key) {
            return rows.delete(key);
        },

        /** Test helper: seed or overwrite a row. */
        seed(row) {
            const copy = {
                id: row.id || nextId++,
                idempotencyKey: row.idempotencyKey,
                requestHash: row.requestHash,
                phone: row.phone,
                status: row.status,
                providerMessageId: row.providerMessageId ?? null,
                attemptCount: row.attemptCount ?? 0,
                lastError: row.lastError ?? null,
                createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt || Date.now()),
                updatedAt: row.updatedAt ? (row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt)) : null,
                sentAt: row.sentAt ? (row.sentAt instanceof Date ? row.sentAt : new Date(row.sentAt)) : null,
            };
            if (copy.id >= nextId) nextId = copy.id + 1;
            rows.set(copy.idempotencyKey, copy);
            return cloneRow(copy);
        },

        clear() {
            rows.clear();
        },
    };
}

module.exports = {
    createMemoryDeliveryStore,
};
