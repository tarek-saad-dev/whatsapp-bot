'use strict';

const {
  getDrvowaOutboundObservedUrl,
  getRuntimeToken,
  isOutboundObservationDeliveryEnabled,
} = require('./s2sAuth');

const DEFAULT_BACKOFF_MS = [0, 2000, 5000, 15000, 30000, 60000, 120000, 300000];

function pickBackoff(table, attempts) {
  const index = Math.min(Math.max(attempts, 0), table.length - 1);
  return table[index];
}

/**
 * Deliver managed outbound observations to DRVOWA SaaS.
 * Feature-gated: default OFF so production does not hammer a missing endpoint.
 */
function createDrvowaOutboundObservationWorker({
  accountKey,
  spool,
  ingestUrl = getDrvowaOutboundObservedUrl(),
  runtimeToken = getRuntimeToken(),
  enabled = isOutboundObservationDeliveryEnabled,
  backoffMs = DEFAULT_BACKOFF_MS,
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

  function deliveryEnabled() {
    return typeof enabled === 'function' ? enabled() : Boolean(enabled);
  }

  function configured() {
    return Boolean(ingestUrl && runtimeToken);
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
      const delayMs = pickBackoff(backoffMs, record.attempts || 0);
      spool.markRetry(record.providerMessageId, {
        nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
        error: `HTTP_${response.status}`,
      });
      lastErrorCode = `HTTP_${response.status}`;
    } finally {
      if (timerHandle) clearTimeout(timerHandle);
    }
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
      const pending = spool.getPendingForDelivery();
      for (const record of pending.slice(0, 10)) {
        try {
          await deliverRecord(record);
        } catch (err) {
          const delayMs = pickBackoff(backoffMs, record.attempts || 0);
          spool.markRetry(record.providerMessageId, {
            nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
            error: err && err.message ? err.message : String(err),
          });
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
};
