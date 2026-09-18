'use strict';

const { buildDrvowaInboundDto } = require('./inboundDto');
const {
  getDrvowaInboundUrl,
  getRuntimeToken,
} = require('./s2sAuth');

/** Standard retry backoff for network / 5xx / 429 / 408. */
const DEFAULT_BACKOFF_MS = [0, 2000, 5000, 15000, 30000, 60000, 120000, 300000];
/** Slow backoff for auth / mapping config errors — never tight-loop. */
const CONFIG_BACKOFF_MS = [60000, 120000, 300000, 600000];

function pickBackoff(table, attempts) {
  const index = Math.min(Math.max(attempts, 0), table.length - 1);
  return table[index];
}

function logInbound(logger, event, fields = {}) {
  const fn = event === 'config_error' || event === 'quarantined'
    ? (logger.warn || logger.info || console.warn).bind(logger)
    : (logger.info || console.log).bind(logger);
  fn(`[drvowa-inbound] ${event}`, fields);
}

/**
 * Reconstruct DRVOWA DTO from durable spool fields after restart.
 * accountKey always comes from managed provider context — never from WA body.
 */
function dtoFromSpoolRecord(record, accountKey) {
  if (record.drvowaDto && typeof record.drvowaDto === 'object') {
    return {
      ...record.drvowaDto,
      accountKey,
      provider: 'baileys',
    };
  }

  const n = record.normalizedEvent || {};
  return buildDrvowaInboundDto({
    accountKey,
    providerMessageId: record.providerMessageId || n.providerMessageId,
    externalContactKey: n.phone || n.externalContactKey || null,
    fromMe: n.direction === 'outbound' || n.fromMe === true,
    isGroup: Boolean(n.isGroup),
    messageTimestamp: n.messageTimestamp != null ? n.messageTimestamp : null,
    receivedAt: n.receivedAt || record.capturedAt || new Date().toISOString(),
    upsertType: n.upsertType || 'notify',
    content: n.text != null ? n.text : (n.content != null ? n.content : null),
  });
}

function classifyDrvowaOutcome(statusCode, body) {
  if (statusCode >= 200 && statusCode < 300) {
    const outcome = body && typeof body.outcome === 'string'
      ? body.outcome.toLowerCase()
      : 'accepted';
    if (outcome === 'duplicate') return 'duplicate';
    if (outcome === 'ignored') return 'ignored';
    return 'accepted';
  }
  if (statusCode === 400) return 'quarantine';
  if (statusCode === 401 || statusCode === 403) return 'auth_config';
  if (statusCode === 404) return 'mapping_config';
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) return 'retry';
  if (statusCode >= 400 && statusCode < 500) return 'quarantine';
  return 'retry';
}

/**
 * Managed-account delivery worker: durable spool → DRVOWA SaaS ingest.
 * Does NOT use legacy Cashier WHATSAPP_INBOX_WEBHOOK_*.
 */
function createDrvowaInboundDeliveryWorker({
  accountKey,
  spool,
  ingestUrl = getDrvowaInboundUrl(),
  runtimeToken = getRuntimeToken(),
  backoffMs = DEFAULT_BACKOFF_MS,
  configBackoffMs = CONFIG_BACKOFF_MS,
  fetchImpl = global.fetch,
  logger = console,
  intervalMs = Number(process.env.DRVOWA_INBOUND_DELIVERY_INTERVAL_MS || 1000),
} = {}) {
  if (!accountKey) {
    throw new Error('accountKey is required for DRVOWA inbound delivery worker');
  }

  let timer = null;
  let running = false;
  let inFlight = false;
  let lastDeliveryAt = null;
  let lastErrorCode = null;
  let lastHttpStatus = null;

  function configured() {
    return Boolean(ingestUrl && runtimeToken);
  }

  function scheduleRetry(record, { delayMs, error, code }) {
    spool.markRetry(record.providerMessageId, {
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      error,
    });
    lastErrorCode = code || null;
    logInbound(logger, 'retry_scheduled', {
      accountKey,
      providerMessageId: record.providerMessageId,
      attempt: (record.attempts || 0) + 1,
      delayMs,
      code: code || undefined,
    });
  }

  async function deliverRecord(record) {
    if (!configured()) {
      const err = new Error('DRVOWA inbound delivery is not configured');
      err.code = 'CONFIG_MISSING';
      throw err;
    }
    if (!fetchImpl) {
      throw new Error('fetch is unavailable in this runtime');
    }

    const dto = dtoFromSpoolRecord(record, accountKey);
    const deliveryStartedAt = new Date().toISOString();
    spool.updateTiming(record.providerMessageId, { deliveryStartedAt });

    const captureMs = record.capturedAt
      ? Date.parse(deliveryStartedAt) - Date.parse(record.capturedAt)
      : null;

    logInbound(logger, 'delivery_start', {
      accountKey,
      providerMessageId: record.providerMessageId,
      attempt: record.attempts || 0,
      captureToStartMs: captureMs,
    });

    const httpStarted = Date.now();
    const response = await fetchImpl(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify(dto),
    });
    const latencyMs = Date.now() - httpStarted;

    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      body = null;
    }

    const deliveryCompletedAt = new Date().toISOString();
    spool.updateTiming(record.providerMessageId, {
      deliveryCompletedAt,
      httpLatencyMs: latencyMs,
    });

    return { response, body, latencyMs, deliveryCompletedAt, dto };
  }

  async function processRecord(record) {
    try {
      const { response, body, latencyMs, deliveryCompletedAt } = await deliverRecord(record);
      lastHttpStatus = response.status;
      const outcome = classifyDrvowaOutcome(response.status, body);

      if (outcome === 'accepted' || outcome === 'duplicate' || outcome === 'ignored') {
        spool.markDelivered(record.providerMessageId);
        lastDeliveryAt = deliveryCompletedAt;
        lastErrorCode = null;
        const captureToAckMs = record.capturedAt
          ? Date.parse(deliveryCompletedAt) - Date.parse(record.capturedAt)
          : null;
        const eventName = outcome === 'duplicate' ? 'duplicate_ack' : 'delivered';
        logInbound(logger, eventName, {
          accountKey,
          providerMessageId: record.providerMessageId,
          attempt: record.attempts || 0,
          status: response.status,
          latencyMs,
          captureToAckMs,
          outcome,
        });
        return;
      }

      if (outcome === 'quarantine') {
        spool.markQuarantined(record.providerMessageId, {
          reason: `HTTP ${response.status}`,
          errors: [`HTTP_${response.status}`],
        });
        lastErrorCode = `HTTP_${response.status}`;
        logInbound(logger, 'quarantined', {
          accountKey,
          providerMessageId: record.providerMessageId,
          status: response.status,
        });
        return;
      }

      if (outcome === 'auth_config' || outcome === 'mapping_config') {
        const delay = pickBackoff(configBackoffMs, record.attempts);
        const code = outcome === 'auth_config' ? 'AUTH_CONFIG' : 'MAPPING_CONFIG';
        scheduleRetry(record, {
          delayMs: delay,
          error: `HTTP ${response.status}`,
          code,
        });
        logInbound(logger, 'config_error', {
          accountKey,
          providerMessageId: record.providerMessageId,
          status: response.status,
          code,
        });
        return;
      }

      // retry
      const delay = pickBackoff(backoffMs, record.attempts + 1);
      scheduleRetry(record, {
        delayMs: delay,
        error: `HTTP ${response.status}`,
        code: `HTTP_${response.status}`,
      });
    } catch (error) {
      const code = error && error.code ? error.code : 'NETWORK_ERROR';
      lastErrorCode = code;
      const delay = code === 'CONFIG_MISSING'
        ? pickBackoff(configBackoffMs, record.attempts)
        : pickBackoff(backoffMs, record.attempts + 1);
      scheduleRetry(record, {
        delayMs: delay,
        error: error && error.message ? error.message : String(error),
        code,
      });
      if (code === 'CONFIG_MISSING' || code === 'AUTH_CONFIG') {
        logInbound(logger, 'config_error', {
          accountKey,
          providerMessageId: record.providerMessageId,
          code,
        });
      }
    }
  }

  async function tick() {
    if (!running || inFlight) return 0;
    inFlight = true;
    let processed = 0;
    try {
      if (!configured()) {
        lastErrorCode = 'CONFIG_MISSING';
        return 0;
      }
      const pending = spool.getPendingForDelivery();
      for (const record of pending.slice(0, 20)) {
        await processRecord(record);
        processed += 1;
        // After auth/mapping config failure, stop this tick to avoid hammering.
        if (lastErrorCode === 'AUTH_CONFIG' || lastErrorCode === 'MAPPING_CONFIG') {
          break;
        }
      }
    } finally {
      inFlight = false;
    }
    return processed;
  }

  function start(ms = intervalMs) {
    if (running) return Promise.resolve(0);
    running = true;
    timer = setInterval(() => {
      tick().catch(() => {});
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    // Drain pending immediately (restart durability); return promise for tests/awaiters.
    return tick().catch(() => 0);
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    const stats = spool.getStats();
    return {
      running,
      mode: 'drvowa',
      configured: configured(),
      ingestUrlConfigured: Boolean(ingestUrl),
      tokenConfigured: Boolean(runtimeToken),
      inFlight,
      pending: stats.pending,
      delivered: stats.delivered,
      failed: stats.failed,
      quarantined: stats.quarantined,
      lastDeliveryAt,
      lastErrorCode,
      lastHttpStatus,
    };
  }

  return {
    start,
    stop,
    tick,
    processRecord,
    getStatus,
    classifyDrvowaOutcome,
    dtoFromSpoolRecord: (record) => dtoFromSpoolRecord(record, accountKey),
    accountKey,
    ingestUrl,
  };
}

module.exports = {
  createDrvowaInboundDeliveryWorker,
  classifyDrvowaOutcome,
  dtoFromSpoolRecord,
  DEFAULT_BACKOFF_MS,
  CONFIG_BACKOFF_MS,
};
