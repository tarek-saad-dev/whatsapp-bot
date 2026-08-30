'use strict';

const { logInbox } = require('./inboxLogger');

function resolveOutboundObservedUrl({
    explicitUrl = process.env.WHATSAPP_OUTBOUND_OBSERVED_WEBHOOK_URL || '',
    inboxUrl = process.env.WHATSAPP_INBOX_WEBHOOK_URL || '',
} = {}) {
    const explicit = String(explicitUrl || '').trim();
    if (explicit) return explicit;
    const inbox = String(inboxUrl || '').trim();
    if (!inbox) return '';
    if (inbox.includes('/api/internal/messaging/inbox/whatsapp')) {
        return inbox.replace(
            '/api/internal/messaging/inbox/whatsapp',
            '/api/internal/messaging/outbound-observed/whatsapp',
        );
    }
    return '';
}

/**
 * Fire-and-forget poster for Cashier outbound-observed webhook.
 * Must never throw into Baileys message handlers.
 */
function createOutboundObservedPoster({
    webhookUrl = resolveOutboundObservedUrl(),
    webhookToken = process.env.WHATSAPP_INBOX_WEBHOOK_TOKEN || '',
    timeoutMs = Number(process.env.WHATSAPP_OUTBOUND_OBSERVED_TIMEOUT_MS || 4000),
    fetchImpl = global.fetch,
} = {}) {
    const seen = new Set();

    async function postOnce(payload) {
        if (!webhookUrl) {
            return { ok: false, reason: 'webhook_unconfigured' };
        }
        if (!fetchImpl) {
            return { ok: false, reason: 'fetch_unavailable' };
        }
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller
            ? setTimeout(() => controller.abort(), Math.max(500, timeoutMs))
            : null;
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (webhookToken) headers.Authorization = `Bearer ${webhookToken}`;
            const response = await fetchImpl(webhookUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                ...(controller ? { signal: controller.signal } : {}),
            });
            let body = null;
            try {
                body = await response.json();
            } catch (_) {
                body = null;
            }
            if (response.status >= 200 && response.status < 300) {
                return { ok: true, status: response.status, body, duplicate: Boolean(body && body.duplicate) };
            }
            return { ok: false, reason: `http_${response.status}`, status: response.status, body };
        } catch (err) {
            return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : (err.message || String(err)) };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function observe(payload) {
        const providerMessageId = String(payload?.providerMessageId || '').trim();
        if (!providerMessageId) {
            return { ok: false, reason: 'missing_provider_message_id' };
        }
        if (seen.has(providerMessageId)) {
            return { ok: true, duplicateLocal: true };
        }
        seen.add(providerMessageId);
        if (seen.size > 2000) {
            const first = seen.values().next().value;
            seen.delete(first);
        }

        const first = await postOnce(payload);
        if (first.ok) {
            logInbox('outbound_observed_forwarded', {
                providerMessageId,
                status: first.status,
                duplicate: first.duplicate || false,
            });
            return first;
        }

        // one bounded retry
        const second = await postOnce(payload);
        if (second.ok) {
            logInbox('outbound_observed_forwarded', {
                providerMessageId,
                status: second.status,
                duplicate: second.duplicate || false,
                retried: true,
            });
            return second;
        }

        logInbox('outbound_observed_forward_failed', {
            providerMessageId,
            reason: second.reason || first.reason,
            status: second.status || first.status || null,
        });
        return second;
    }

    function getStatus() {
        return {
            webhookConfigured: Boolean(webhookUrl),
            timeoutMs,
        };
    }

    return {
        observe,
        postOnce,
        getStatus,
        resolveOutboundObservedUrl,
    };
}

module.exports = {
    createOutboundObservedPoster,
    resolveOutboundObservedUrl,
};
