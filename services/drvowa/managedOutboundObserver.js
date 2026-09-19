'use strict';

/**
 * Managed fromMe observation → classify API vs human → durable spool.
 * Replaces the noop outboundObservedPoster for managed accounts only.
 * Reconciles matching SENDING reservations before classification.
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

  async function observe(payload) {
    try {
      const providerMessageId = String(payload?.providerMessageId || '').trim();
      if (!providerMessageId) {
        return { skipped: true, reason: 'missing_provider_message_id' };
      }

      let origin = idempotencyStore && idempotencyStore.isApiOrigin(providerMessageId)
        ? 'DRVOWA_API'
        : 'HUMAN_MANUAL';

      const phone = payload.phone || null;
      const text = payload.text != null ? String(payload.text) : null;

      if (
        origin !== 'DRVOWA_API'
        && idempotencyStore
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
          origin = 'DRVOWA_API';
          (logger.info || console.log).bind(logger)(
            '[drvowa-outbound] reconciled_from_observation',
            {
              accountKey,
              idempotencyKey: recon.idempotencyKey || null,
              providerMessageId,
            },
          );
        }
      } else if (
        origin !== 'DRVOWA_API'
        && idempotencyStore
        && typeof idempotencyStore.reconcileSendingFromObservation === 'function'
        && phone
        && text == null
      ) {
        // Without text we cannot safely hash-match; leave HUMAN_MANUAL.
      }

      const externalContactKey = phone
        ? `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`
        : (payload?.rawPayload?.resolvedCustomerJid || null);

      const { record, duplicate } = observationSpool.capture({
        accountKey,
        providerMessageId,
        origin,
        phone,
        externalContactKey,
        occurredAt: payload.occurredAt || new Date().toISOString(),
      });

      const event = origin === 'DRVOWA_API' ? 'observed_api' : 'observed_human';
      (logger.info || console.log).bind(logger)(`[drvowa-outbound] ${event}`, {
        accountKey,
        providerMessageId,
        origin,
      });

      if (!duplicate) {
        (logger.info || console.log).bind(logger)('[drvowa-outbound] observation_queued', {
          accountKey,
          providerMessageId,
          origin,
        });
        if (observationWorker && typeof observationWorker.kick === 'function') {
          observationWorker.kick();
        }
      }

      return { ok: true, origin, duplicate: Boolean(duplicate), record };
    } catch (err) {
      (logger.warn || logger.info || console.warn).bind(logger)(
        '[drvowa-outbound] observe_error',
        {
          accountKey,
          code: err && err.code ? err.code : 'OBSERVE_FAILED',
        },
      );
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
  };
}

module.exports = {
  createManagedOutboundObserver,
};
