'use strict';

/**
 * Managed fromMe observation → classify API / human / unresolved → durable spool.
 * Replaces the noop outboundObservedPoster for managed accounts only.
 *
 * UNRESOLVED is runtime-only: held locally, never POSTed to SaaS (no HUMAN_PAUSED).
 */
function createManagedOutboundObserver({
  accountKey,
  idempotencyStore,
  observationSpool,
  observationWorker = null,
  logger = console,
} = {}) {
  if (!accountKey) {
    throw new Error('accountKey is required for managed outbound observer');
  }

  function logInfo(event, fields) {
    (logger.info || console.log).bind(logger)(`[drvowa-outbound] ${event}`, fields);
  }

  function logWarn(event, fields) {
    (logger.warn || logger.info || console.warn).bind(logger)(
      `[drvowa-outbound] ${event}`,
      fields,
    );
  }

  /**
   * Positive-evidence classification.
   * Ambiguity / insufficient evidence → UNRESOLVED (never HUMAN_MANUAL).
   */
  function classifyOrigin({ providerMessageId, phone, text }) {
    if (idempotencyStore && idempotencyStore.isApiOrigin(providerMessageId)) {
      return { origin: 'DRVOWA_API', reason: 'provider_correlated' };
    }

    const hasPhoneSending = Boolean(
      phone
      && idempotencyStore
      && typeof idempotencyStore.hasSendingForPhone === 'function'
      && idempotencyStore.hasSendingForPhone(phone),
    );

    if (
      idempotencyStore
      && typeof idempotencyStore.reconcileSendingFromObservation === 'function'
      && phone
      && text != null
    ) {
      const recon = idempotencyStore.reconcileSendingFromObservation({
        phone,
        text,
        providerMessageId,
      });
      if (recon.reconciled) {
        logInfo('reconciled_from_observation', {
          accountKey,
          idempotencyKey: recon.idempotencyKey || null,
          providerMessageId,
        });
        return {
          origin: 'DRVOWA_API',
          reason: 'reconciled',
          idempotencyKey: recon.idempotencyKey || null,
        };
      }
      if (recon.reason === 'ambiguous_match') {
        return { origin: 'UNRESOLVED', reason: 'ambiguous_match', matchCount: recon.matchCount };
      }
      // Exact hash no_match but unresolved SENDING for this phone → ambiguous.
      if (hasPhoneSending) {
        return { origin: 'UNRESOLVED', reason: 'sending_phone_text_mismatch' };
      }
      return { origin: 'HUMAN_MANUAL', reason: 'no_api_possibility' };
    }

    // Null/missing text with SENDING for phone → cannot safely hash-match.
    if (phone && text == null && hasPhoneSending) {
      return { origin: 'UNRESOLVED', reason: 'sending_phone_null_text' };
    }

    // Insufficient destination identity while any SENDING exists → fail closed.
    if (
      !phone
      && idempotencyStore
      && typeof idempotencyStore.hasAnySending === 'function'
      && idempotencyStore.hasAnySending()
    ) {
      return { origin: 'UNRESOLVED', reason: 'insufficient_identity' };
    }

    if (phone && !hasPhoneSending) {
      return { origin: 'HUMAN_MANUAL', reason: 'no_sending_for_phone' };
    }

    return { origin: 'HUMAN_MANUAL', reason: 'no_api_possibility' };
  }

  async function observe(payload) {
    try {
      const providerMessageId = String(payload?.providerMessageId || '').trim();
      if (!providerMessageId) {
        return { skipped: true, reason: 'missing_provider_message_id' };
      }

      const phone = payload.phone || null;
      const text = payload.text != null ? String(payload.text) : null;
      const classified = classifyOrigin({ providerMessageId, phone, text });

      const externalContactKey = phone
        ? `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`
        : (payload?.rawPayload?.resolvedCustomerJid || null);

      const captureFn = typeof observationSpool.captureOrPromote === 'function'
        ? observationSpool.captureOrPromote.bind(observationSpool)
        : observationSpool.capture.bind(observationSpool);

      const {
        record,
        duplicate,
        promoted = false,
        conflict = false,
      } = captureFn({
        accountKey,
        providerMessageId,
        origin: classified.origin,
        phone,
        externalContactKey,
        occurredAt: payload.occurredAt || new Date().toISOString(),
      });

      // Return the durable stored origin (never a conflicting guess).
      const storedOrigin = record.origin;

      if (conflict) {
        logWarn('observation_origin_conflict', {
          accountKey,
          providerMessageId,
          storedOrigin,
          proposedOrigin: classified.origin,
        });
      }

      if (promoted) {
        logInfo('observation_promoted', {
          accountKey,
          providerMessageId,
          origin: storedOrigin,
        });
      }

      const event = storedOrigin === 'DRVOWA_API'
        ? 'observed_api'
        : storedOrigin === 'UNRESOLVED'
          ? 'observed_unresolved'
          : 'observed_human';
      logInfo(event, {
        accountKey,
        providerMessageId,
        origin: storedOrigin,
        reason: classified.reason,
      });

      const deliveryEligible = storedOrigin === 'DRVOWA_API'
        || storedOrigin === 'HUMAN_MANUAL';

      if ((!duplicate || promoted) && deliveryEligible) {
        logInfo('observation_queued', {
          accountKey,
          providerMessageId,
          origin: storedOrigin,
        });
        if (observationWorker && typeof observationWorker.kick === 'function') {
          observationWorker.kick();
        }
      } else if (!duplicate && storedOrigin === 'UNRESOLVED') {
        logInfo('observation_held_unresolved', {
          accountKey,
          providerMessageId,
        });
      }

      return {
        ok: true,
        origin: storedOrigin,
        duplicate: Boolean(duplicate),
        promoted: Boolean(promoted),
        record,
      };
    } catch (err) {
      logWarn('observe_error', {
        accountKey,
        code: err && err.code ? err.code : 'OBSERVE_FAILED',
      });
      return { ok: false, reason: err && err.message ? err.message : String(err) };
    }
  }

  function getStatus() {
    return {
      mode: 'managed',
      accountKey,
      spool: observationSpool.getStats(),
    };
  }

  return {
    observe,
    getStatus,
    classifyOrigin,
  };
}

module.exports = {
  createManagedOutboundObserver,
};
