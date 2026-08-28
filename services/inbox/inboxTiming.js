'use strict';

const { performance } = require('perf_hooks');

function utcNow() {
    return new Date().toISOString();
}

function monotonicMs() {
    return performance.now();
}

function msBetween(startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    return Math.max(0, Math.round(endMs - startMs));
}

function isoBetween(startIso, endIso) {
    if (!startIso || !endIso) return null;
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.max(0, end - start);
}

function createInboundTiming(seed = {}) {
    const timing = {
        waDetectedAt: seed.waDetectedAt || null,
        captureStartedAt: seed.captureStartedAt || null,
        captureCompletedAt: seed.captureCompletedAt || null,
        spoolPersistedAt: seed.spoolPersistedAt || null,
        webhookStartedAt: seed.webhookStartedAt || null,
        webhookCompletedAt: seed.webhookCompletedAt || null,
        browserQueueWaitMs: seed.browserQueueWaitMs ?? null,
        browserOperationMs: seed.browserOperationMs ?? null,
        _monotonic: {},
    };

    function markMonotonic(key) {
        timing._monotonic[key] = monotonicMs();
    }

    function setUtc(key, value = utcNow()) {
        timing[key] = value;
    }

    function finalize() {
        timing.captureLatencyMs = isoBetween(timing.captureStartedAt, timing.captureCompletedAt);
        timing.spoolWriteMs = isoBetween(timing.captureCompletedAt, timing.spoolPersistedAt);
        timing.webhookLatencyMs = isoBetween(timing.webhookStartedAt, timing.webhookCompletedAt);
        timing.totalInboundDeliveryMs = isoBetween(timing.waDetectedAt, timing.webhookCompletedAt);
        delete timing._monotonic;
        return timing;
    }

    return {
        timing,
        markMonotonic,
        setUtc,
        finalize,
    };
}

function summarizeTimingForLog(timing) {
    if (!timing) return {};
    return {
        captureLatencyMs: timing.captureLatencyMs,
        spoolWriteMs: timing.spoolWriteMs,
        webhookLatencyMs: timing.webhookLatencyMs,
        totalInboundDeliveryMs: timing.totalInboundDeliveryMs,
        browserQueueWaitMs: timing.browserQueueWaitMs,
        browserOperationMs: timing.browserOperationMs,
    };
}

module.exports = {
    utcNow,
    monotonicMs,
    msBetween,
    isoBetween,
    createInboundTiming,
    summarizeTimingForLog,
};
