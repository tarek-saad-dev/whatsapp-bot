'use strict';

const { STATUSES, CODES, getStaleProcessingMs } = require('./constants');
const { computeRequestHash } = require('./requestHash');
const { getDeliveryStore } = require('./deliveryStore');

function isStaleProcessing(row, now, staleMs) {
    if (!row || row.status !== STATUSES.PROCESSING) return false;
    const pivot = row.updatedAt || row.createdAt;
    if (!pivot) return false;
    const age = now.getTime() - new Date(pivot).getTime();
    return Number.isFinite(age) && age > staleMs;
}

async function resolveExistingRow(store, { key, hash, now, staleMs }, depth = 0) {
    if (depth > 3) {
        const row = await store.getByKey(key);
        return { action: 'in_progress', code: CODES.IDEMPOTENCY_IN_PROGRESS, row };
    }

    const row = await store.getByKey(key);
    if (!row) {
        return { action: 'missing' };
    }

    if (row.requestHash !== hash) {
        return { action: 'conflict', code: CODES.IDEMPOTENCY_CONFLICT, row };
    }

    if (row.status === STATUSES.SENT) {
        return { action: 'replay', row };
    }

    if (row.status === STATUSES.UNKNOWN) {
        return { action: 'unknown', code: CODES.DELIVERY_STATUS_UNKNOWN, row };
    }

    if (row.status === STATUSES.PROCESSING) {
        if (isStaleProcessing(row, now, staleMs)) {
            await store.markUnknown(key, 'stale_processing', now);
            const refreshed = await store.getByKey(key);
            return {
                action: 'unknown',
                code: CODES.DELIVERY_STATUS_UNKNOWN,
                reason: 'stale_processing',
                row: refreshed || row,
            };
        }
        return { action: 'in_progress', code: CODES.IDEMPOTENCY_IN_PROGRESS, row };
    }

    if (row.status === STATUSES.RETRYABLE_FAILED) {
        const claimed = await store.claimRetryableFailed(key, now);
        if (claimed.claimed) {
            return { action: 'send', row: claimed.row || row, retry: true };
        }
        return resolveExistingRow(store, { key, hash, now, staleMs }, depth + 1);
    }

    return { action: 'unknown', code: CODES.DELIVERY_STATUS_UNKNOWN, row };
}

/**
 * Claim exclusive right to send, or return a durable replay/conflict/in-progress result.
 * Does not send WhatsApp.
 */
async function claimDelivery({
    idempotencyKey,
    normalizedPhone,
    trimmedMessage,
    now = new Date(),
    store = getDeliveryStore(),
    staleMs = getStaleProcessingMs(),
}) {
    const hash = computeRequestHash(normalizedPhone, trimmedMessage);
    const inserted = await store.insertClaim({
        key: idempotencyKey,
        hash,
        phone: normalizedPhone,
        now,
    });

    if (inserted.inserted) {
        return { action: 'send', hash, row: inserted.row || null, retry: false };
    }

    return {
        hash,
        ...(await resolveExistingRow(store, { key: idempotencyKey, hash, now, staleMs })),
    };
}

async function recordSendOutcome({
    idempotencyKey,
    sendResult,
    error,
    store = getDeliveryStore(),
    now = new Date(),
    preSendFailure = false,
}) {
    if (preSendFailure) {
        const message = (sendResult && sendResult.error) || (error && error.message) || 'pre_send_failure';
        await store.markRetryableFailed(idempotencyKey, message, now);
        return { ledgerStatus: STATUSES.RETRYABLE_FAILED };
    }

    if (sendResult && sendResult.success && sendResult.messageId) {
        const marked = await store.markSent(idempotencyKey, sendResult.messageId, now);
        if (!marked.updated) {
            await store.markUnknown(idempotencyKey, 'mark_sent_failed', now);
            return { ledgerStatus: STATUSES.UNKNOWN, reason: 'mark_sent_failed' };
        }
        return { ledgerStatus: STATUSES.SENT, messageId: sendResult.messageId };
    }

    if (sendResult && sendResult.success && !sendResult.messageId) {
        await store.markUnknown(idempotencyKey, 'missing_message_id', now);
        return { ledgerStatus: STATUSES.UNKNOWN, reason: 'missing_message_id' };
    }

    await store.markUnknown(
        idempotencyKey,
        (sendResult && sendResult.error) || (error && error.message) || 'ambiguous_send_failure',
        now,
    );
    return { ledgerStatus: STATUSES.UNKNOWN, reason: 'ambiguous_send_failure' };
}

module.exports = {
    claimDelivery,
    recordSendOutcome,
    isStaleProcessing,
    computeRequestHash,
};
