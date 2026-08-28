'use strict';

const { logInbox } = require('./inboxLogger');
const { utcNow, summarizeTimingForLog } = require('./inboxTiming');

const DEFAULT_BACKOFF_MS = [0, 2000, 5000, 15000, 30000, 60000, 120000, 300000];

function createInboxDeliveryWorker({
    spool,
    webhookUrl = process.env.WHATSAPP_INBOX_WEBHOOK_URL || '',
    webhookToken = process.env.WHATSAPP_INBOX_WEBHOOK_TOKEN || '',
    backoffMs = DEFAULT_BACKOFF_MS,
    fetchImpl = global.fetch,
} = {}) {
    let timer = null;
    let running = false;
    let inFlight = false;

    function nextBackoff(attempts) {
        const index = Math.min(Math.max(attempts, 0), backoffMs.length - 1);
        return backoffMs[index];
    }

    function buildHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (webhookToken) {
            headers.Authorization = `Bearer ${webhookToken}`;
        }
        return headers;
    }

    async function deliverRecord(record) {
        if (!webhookUrl) {
            throw new Error('WHATSAPP_INBOX_WEBHOOK_URL is not configured');
        }
        if (!fetchImpl) {
            throw new Error('fetch is unavailable in this runtime');
        }

        const webhookStartedAt = utcNow();
        spool.updateTiming(record.providerMessageId, { webhookStartedAt });

        const response = await fetchImpl(webhookUrl, {
            method: 'POST',
            headers: buildHeaders(),
            body: JSON.stringify(record.normalizedEvent),
        });

        const webhookCompletedAt = utcNow();
        spool.updateTiming(record.providerMessageId, { webhookCompletedAt });

        let body = null;
        try {
            body = await response.json();
        } catch (_) {
            body = null;
        }

        return { response, body, webhookStartedAt, webhookCompletedAt };
    }

    function classifyOutcome(statusCode, body) {
        if (statusCode >= 200 && statusCode < 300) {
            if (body && body.ok === true) {
                return body.duplicate ? 'duplicate' : 'delivered';
            }
            return 'delivered';
        }
        if (statusCode >= 400 && statusCode < 500) {
            return 'permanent';
        }
        return 'retry';
    }

    function logDeliveryTiming(record) {
        const timing = { ...(record.timing || {}) };
        if (timing.webhookStartedAt && timing.webhookCompletedAt) {
            timing.webhookLatencyMs = Date.parse(timing.webhookCompletedAt) - Date.parse(timing.webhookStartedAt);
        }
        if (timing.waDetectedAt && timing.webhookCompletedAt) {
            timing.totalInboundDeliveryMs = Date.parse(timing.webhookCompletedAt) - Date.parse(timing.waDetectedAt);
        }
        logInbox('inbound_latency', {
            providerMessageId: record.providerMessageId,
            idSource: record.normalizedEvent.idSource,
            ...summarizeTimingForLog(timing),
        });
    }

    async function processRecord(record) {
        try {
            const { response, body } = await deliverRecord(record);
            const refreshed = spool.getRecord(record.providerMessageId) || record;
            const outcome = classifyOutcome(response.status, body);

            if (outcome === 'delivered') {
                const delivered = spool.markDelivered(record.providerMessageId);
                logInbox('delivered_to_erp', {
                    providerMessageId: record.providerMessageId,
                    idSource: record.normalizedEvent.idSource,
                    chatTitle: record.normalizedEvent.chatTitle,
                });
                logDeliveryTiming(delivered || refreshed);
                return;
            }

            if (outcome === 'duplicate') {
                const delivered = spool.markDelivered(record.providerMessageId);
                logInbox('duplicate_acknowledged_by_erp', {
                    providerMessageId: record.providerMessageId,
                    idSource: record.normalizedEvent.idSource,
                });
                logDeliveryTiming(delivered || refreshed);
                return;
            }

            if (outcome === 'permanent') {
                spool.markRetry(record.providerMessageId, {
                    error: `HTTP ${response.status}`,
                    permanent: true,
                });
                logInbox('permanent_delivery_error', {
                    providerMessageId: record.providerMessageId,
                    status: response.status,
                });
                return;
            }

            const delay = nextBackoff(record.attempts + 1);
            spool.markRetry(record.providerMessageId, {
                nextRetryAt: new Date(Date.now() + delay).toISOString(),
                error: `HTTP ${response.status}`,
            });
            logInbox('retry_scheduled', {
                providerMessageId: record.providerMessageId,
                attempts: record.attempts + 1,
                delayMs: delay,
            });
        } catch (error) {
            const delay = nextBackoff(record.attempts + 1);
            spool.markRetry(record.providerMessageId, {
                nextRetryAt: new Date(Date.now() + delay).toISOString(),
                error: error.message || String(error),
            });
            logInbox('retry_scheduled', {
                providerMessageId: record.providerMessageId,
                attempts: record.attempts + 1,
                delayMs: delay,
                reason: 'network_error',
            });
        }
    }

    async function tick() {
        if (!running || inFlight || !webhookUrl) return 0;
        inFlight = true;
        let processed = 0;
        try {
            const pending = spool.getPendingForDelivery();
            for (const record of pending.slice(0, 20)) {
                await processRecord(record);
                processed += 1;
            }
        } finally {
            inFlight = false;
        }
        return processed;
    }

    function start(intervalMs = Number(process.env.WHATSAPP_INBOX_DELIVERY_INTERVAL_MS || 1000)) {
        if (running) return;
        running = true;
        timer = setInterval(() => {
            tick().catch((error) => {
                logInbox('delivery_worker_failure', { error: error.message });
            });
        }, intervalMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        tick().catch(() => {});
    }

    function stop() {
        running = false;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    function getStatus() {
        return {
            running,
            webhookConfigured: Boolean(webhookUrl),
            inFlight,
        };
    }

    return {
        start,
        stop,
        tick,
        processRecord,
        getStatus,
        nextBackoff,
        classifyOutcome,
    };
}

module.exports = {
    createInboxDeliveryWorker,
    DEFAULT_BACKOFF_MS,
};
