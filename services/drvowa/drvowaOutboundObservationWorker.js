'use strict';

const {
  getDrvowaOutboundObservedUrl,
  getRuntimeToken,
  isOutboundObservationDeliveryEnabled,
} = require('./s2sAuth');

const DEFAULT_BACKOFF_MS = [0, 2000, 5000, 15000, 30000, 60000, 120000, 300000];
const DEFAULT_MAX_ATTEMPTS = 8;
/** Soft 404s become permanent after this many consecutive HTTP_404 failures. */
const PERSISTENT_404_THRESHOLD = 3;

function pickBackoff(table, attempts) {
  const index = Math.min(Math.max(attempts, 0), table.length - 1);
  return table[index];
}

/**
 * Classify outbound-observation HTTP outcomes.
 * 404 is soft until PERSISTENT_404_THRESHOLD consecutive failures.
 */
function classifyOutboundObservationOutcome(statusCode, { consecutive404 = 0 } = {}) {
  if (statusCode >= 200 && statusCode < 300) return 'delivered';
  if (statusCode === 400 || statusCode === 401 || statusCode === 403) return 'permanent';
  if (statusCode === 404) {
    return consecutive404 + 1 >= PERSISTENT_404_THRESHOLD ? 'permanent' : 'retry';
  }
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) return 'retry';
  if (statusCode >= 400 && statusCode < 500) return 'permanent';
  return 'retry';
}

function countConsecutive404(record) {
  if (!record) return 0;
  const err = String(record.lastError || '');
  if (err === 'HTTP_404') return Number(record.attempts || 0);
  return 0;
}

/**
 * Deliver managed outbound observations to DRVOWA SaaS.
 * Feature-gated: default OFF so production does not hammer a missing endpoint.
 * UNRESOLVED spool records are never selected for delivery.
 */
function createDrvowaOutboundObservationWorker({
  accountKey,
  spool,
  ingestUrl = getDrvowaOutboundObservedUrl(),
  runtimeToken = getRuntimeToken(),
  enabled = isOutboundObservationDeliveryEnabled,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  fetchImpl = global.fetch,
  logger = console,
  intervalMs = Number(process.env.DRVOWA_OUTBOUND_OBS_DELIVERY_INTERVAL_MS || 2000),
} = {}) {
  if (!accountKey) {
    throw new Error('accountKey is required for outbound observation worker');
  }

  let timer = null;
  let running = false;
  let inFlight = false;
  let lastDeliveryAt = null;
  let lastErrorCode = null;
  let fetchAttempts = 0;
  let unresolvedSaturatedLogged = false;

  function deliveryEnabled() {
    return typeof enabled === 'function' ? enabled() : Boolean(enabled);
  }

  function configured() {
    return Boolean(ingestUrl && runtimeToken);
  }

  function logInfo(event, fields) {
    (logger.info || console.log).bind(logger)(`[drvowa-outbound] ${event}`, fields);
  }

  function failPermanent(record, error) {
    if (typeof spool.markFailed === 'function') {
      spool.markFailed(record.providerMessageId, error);
    } else {
      spool.markRetry(record.providerMessageId, {
        nextRetryAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        error,
      });
    }
    lastErrorCode = error;
    logInfo('observation_delivery_failed', {
      accountKey,
      providerMessageId: record.providerMessageId,
      error,
    });
  }

  function scheduleRetry(record, error) {
    const attempts = record.attempts || 0;
    if (attempts + 1 >= maxAttempts) {
      failPermanent(record, error || 'MAX_ATTEMPTS');
      return;
    }
    const delayMs = pickBackoff(backoffMs, attempts);
    spool.markRetry(record.providerMessageId, {
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      error,
    });
    lastErrorCode = error;
  }

  async function deliverRecord(record) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timerHandle = controller
      ? setTimeout(() => controller.abort(), 8000)
      : null;
    try {
      fetchAttempts += 1;
      const response = await fetchImpl(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${runtimeToken}`,
        },
        body: JSON.stringify({
          accountKey,
          provider: 'baileys',
          providerMessageId: record.providerMessageId,
          origin: record.origin,
          phone: record.phone,
          externalContactKey: record.externalContactKey,
          occurredAt: record.occurredAt,
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.status >= 200 && response.status < 300) {
        spool.markDelivered(record.providerMessageId);
        lastDeliveryAt = new Date().toISOString();
        lastErrorCode = null;
        return;
      }

      const consecutive404 = countConsecutive404(record);
      const outcome = classifyOutboundObservationOutcome(response.status, { consecutive404 });
      const error = `HTTP_${response.status}`;
      if (outcome === 'permanent') {
        failPermanent(record, error);
        return;
      }
      scheduleRetry(record, error);
    } finally {
      if (timerHandle) clearTimeout(timerHandle);
    }
  }

  function maybeWarnUnresolvedSaturation() {
    const stats = spool.getStats();
    if (stats.unresolvedSaturated && !unresolvedSaturatedLogged) {
      unresolvedSaturatedLogged = true;
      logInfo('unresolved_saturated', {
        accountKey,
        unresolved: stats.unresolved,
        maxUnresolvedWarn: stats.maxUnresolvedWarn,
        oldestUnresolvedCapturedAt: stats.oldestUnresolvedCapturedAt || null,
      });
    }
    if (!stats.unresolvedSaturated) unresolvedSaturatedLogged = false;
  }

  async function tick() {
    if (inFlight) return;
    if (!deliveryEnabled()) {
      lastErrorCode = 'DELIVERY_DISABLED';
      return;
    }
    if (!configured()) {
      lastErrorCode = 'CONFIG_MISSING';
      return;
    }
    inFlight = true;
    try {
      maybeWarnUnresolvedSaturation();
      const pending = spool.getPendingForDelivery();
      for (const record of pending.slice(0, 10)) {
        try {
          await deliverRecord(record);
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          scheduleRetry(record, msg);
          lastErrorCode = 'DELIVERY_ERROR';
        }
      }
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(() => {
      tick().catch(() => {});
    }, Math.max(500, intervalMs));
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function kick() {
    if (!deliveryEnabled()) return;
    tick().catch(() => {});
  }

  function getStatus() {
    const stats = spool.getStats();
    return {
      running,
      deliveryEnabled: deliveryEnabled(),
      pending: stats.pending,
      unresolved: stats.unresolved || 0,
      delivered: stats.delivered,
      failed: stats.failed,
      oldestUnresolvedCapturedAt: stats.oldestUnresolvedCapturedAt || null,
      unresolvedSaturated: Boolean(stats.unresolvedSaturated),
      inFlight,
      lastDeliveryAt,
      lastErrorCode,
      fetchAttempts,
    };
  }

  return {
    start,
    stop,
    tick,
    kick,
    getStatus,
  };
}

module.exports = {
  createDrvowaOutboundObservationWorker,
  classifyOutboundObservationOutcome,
  PERSISTENT_404_THRESHOLD,
  DEFAULT_MAX_ATTEMPTS,
};
