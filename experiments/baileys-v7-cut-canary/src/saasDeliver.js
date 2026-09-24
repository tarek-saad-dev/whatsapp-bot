'use strict';

/**
 * Minimal S2S delivery to DRVOWA SaaS inbound ingest.
 * In-memory delivered set for process lifetime + HTTP idempotency via providerMessageId.
 */

export function createSaasDeliverer({
  accountKey,
  ingestUrl,
  runtimeToken,
  fetchImpl = globalThis.fetch,
  logger = console,
  enabled = false,
} = {}) {
  const delivered = new Set();
  const stats = {
    attempted: 0,
    accepted: 0,
    duplicate: 0,
    failed: 0,
    skipped: 0,
    lastStatus: null,
    lastErrorCode: null,
    lastProviderMessageId: null,
  };

  function configured() {
    return Boolean(enabled && ingestUrl && runtimeToken && accountKey && fetchImpl);
  }

  async function deliver(dto) {
    stats.attempted += 1;
    const pmid = dto?.providerMessageId;
    if (!pmid) {
      stats.skipped += 1;
      return { ok: false, reason: 'missing_pmid' };
    }
    if (delivered.has(pmid)) {
      stats.duplicate += 1;
      return { ok: true, outcome: 'local_duplicate' };
    }
    if (!configured()) {
      stats.skipped += 1;
      return { ok: false, reason: 's2s_disabled_or_unconfigured' };
    }

    const body = { ...dto, accountKey, provider: 'baileys' };
    // Never log text/content
    logger.log?.('[canary-s2s] delivery_start', JSON.stringify({
      providerMessageId: pmid,
      textLength: typeof body.content === 'string' ? body.content.length : 0,
    }));

    try {
      const res = await fetchImpl(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${runtimeToken}`,
        },
        body: JSON.stringify(body),
      });
      stats.lastStatus = res.status;
      stats.lastProviderMessageId = pmid;
      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }

      const duplicate = Boolean(
        parsed?.duplicate
        || parsed?.outcome === 'duplicate'
        || parsed?.code === 'DUPLICATE',
      );
      if (res.status >= 200 && res.status < 300) {
        delivered.add(pmid);
        if (duplicate) stats.duplicate += 1;
        else stats.accepted += 1;
        logger.log?.('[canary-s2s] delivery_ok', JSON.stringify({
          status: res.status,
          duplicate,
          providerMessageId: pmid,
        }));
        return { ok: true, outcome: duplicate ? 'duplicate' : 'accepted', status: res.status };
      }

      stats.failed += 1;
      stats.lastErrorCode = parsed?.code || `HTTP_${res.status}`;
      logger.log?.('[canary-s2s] delivery_fail', JSON.stringify({
        status: res.status,
        code: stats.lastErrorCode,
        providerMessageId: pmid,
      }));
      return { ok: false, reason: 'http_error', status: res.status, code: stats.lastErrorCode };
    } catch (err) {
      stats.failed += 1;
      stats.lastErrorCode = 'NETWORK';
      logger.log?.('[canary-s2s] delivery_error', JSON.stringify({
        error: String(err?.message || err).slice(0, 120),
        providerMessageId: pmid,
      }));
      return { ok: false, reason: 'network', error: String(err?.message || err).slice(0, 120) };
    }
  }

  return {
    configured,
    deliver,
    getStats: () => ({ ...stats, deliveredCount: delivered.size }),
    markDeliveredLocal: (pmid) => delivered.add(pmid),
  };
}

export function buildIngestUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}/api/runtime/whatsapp/inbound`;
}
