'use strict';

const STATUSES = Object.freeze({
    PROCESSING: 'processing',
    SENT: 'sent',
    RETRYABLE_FAILED: 'retryable_failed',
    UNKNOWN: 'unknown',
});

const KNOWN_STATUSES = Object.freeze([
    STATUSES.PROCESSING,
    STATUSES.SENT,
    STATUSES.RETRYABLE_FAILED,
    STATUSES.UNKNOWN,
]);

const CODES = Object.freeze({
    IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
    IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
    DELIVERY_STATUS_UNKNOWN: 'DELIVERY_STATUS_UNKNOWN',
    RETRYABLE_FAILED: 'RETRYABLE_FAILED',
});

const DEFAULT_STALE_PROCESSING_MS = 10 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function getStaleProcessingMs() {
    const raw = process.env.GATEWAY_IDEMPOTENCY_STALE_MS;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_STALE_PROCESSING_MS;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STALE_PROCESSING_MS;
}

module.exports = {
    STATUSES,
    KNOWN_STATUSES,
    CODES,
    DEFAULT_STALE_PROCESSING_MS,
    MAX_IDEMPOTENCY_KEY_LENGTH,
    getStaleProcessingMs,
};
