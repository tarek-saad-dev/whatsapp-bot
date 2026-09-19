'use strict';

const { hashPayload, STATES } = require('./outboundIdempotencyStore');

function validateIdempotencyKey(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: 'idempotencyKey is required' };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: 'idempotencyKey must be non-empty' };
  }
  if (trimmed.length > 200) {
    return { ok: false, error: 'idempotencyKey must be at most 200 characters' };
  }
  return { ok: true, idempotencyKey: trimmed };
}

function logOutbound(logger, event, fields = {}) {
  const fn = (logger.info || console.log).bind(logger);
  fn(`[drvowa-outbound] ${event}`, fields);
}

function isAmbiguousSendResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.outcomeUnknown === true) return true;
  if (result.sendAttempted === true) return true;
  if (result.code === 'OUTBOUND_RESULT_UNKNOWN') return true;
  return false;
}

function isDefinitivePreSendFailure(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.sendAttempted === true || result.outcomeUnknown === true) return false;
  if (result.sendAttempted === false) return true;
  // Legacy/transport results without flags that failed before attempt.
  const definitiveCodes = new Set([
    'NOT_READY',
    'LOGGED_OUT',
    'NOT_STARTED',
    'INVALID_PAYLOAD',
    'IDEMPOTENCY_KEY_REQUIRED',
  ]);
  if (result.code && definitiveCodes.has(result.code)) return true;
  if (result.success === false && result.sendAttempted == null) {
    // Conservative: without sendAttempted metadata, treat as definitive only when
    // error clearly indicates pre-send validation (invalid phone etc).
    const err = String(result.error || '').toLowerCase();
    if (err.includes('invalid') || err.includes('not ready') || err.includes('logged out')) {
      return true;
    }
  }
  return false;
}

/**
 * Queue DRVOWA_API outbound observation after a definitive successful send.
 * Failures here must never change the send result (WhatsApp delivery is authoritative).
 */
async function queueApiOutboundObservation({
  accountKey,
  phone,
  message,
  providerMessageId,
  observeApiOutbound,
  logger = console,
}) {
  if (typeof observeApiOutbound !== 'function') return;
  const id = String(providerMessageId || '').trim();
  if (!id) return;

  try {
    const result = await observeApiOutbound({
      providerMessageId: id,
      phone: phone != null ? String(phone) : null,
      text: message != null ? String(message) : null,
      occurredAt: new Date().toISOString(),
    });
    if (result && result.ok === false) {
      logOutbound(logger, 'api_observation_failed', {
        accountKey,
        providerMessageId: id,
        reason: result.reason || 'observe_failed',
      });
      return;
    }
    logOutbound(logger, 'api_observation_queued', {
      accountKey,
      providerMessageId: id,
      duplicate: Boolean(result && result.duplicate),
    });
  } catch (err) {
    logOutbound(logger, 'api_observation_failed', {
      accountKey,
      providerMessageId: id,
      code: err && err.code ? err.code : 'API_OBS_FAILED',
    });
  }
}

/**
 * Idempotent managed outbound send (must run inside per-account send queue).
 */
async function sendManagedWithIdempotency({
  accountKey,
  phone,
  message,
  idempotencyKey: rawKey,
  store,
  sendFn,
  observeApiOutbound = null,
  logger = console,
}) {
  const keyCheck = validateIdempotencyKey(rawKey);
  if (!keyCheck.ok) {
    return {
      success: false,
      status: 'failed',
      error: keyCheck.error,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      httpStatus: 400,
    };
  }
  const idempotencyKey = keyCheck.idempotencyKey;
  const payloadHash = hashPayload({ phone, message });
  const existing = store.get(idempotencyKey);

  if (existing) {
    if (existing.payloadHash && existing.payloadHash !== payloadHash) {
      return {
        success: false,
        status: 'failed',
        error: 'Idempotency key was already used with a different destination or payload',
        code: 'IDEMPOTENCY_CONFLICT',
        idempotencyKey,
        httpStatus: 409,
      };
    }

    if (existing.state === STATES.SENT) {
      logOutbound(logger, 'duplicate', {
        accountKey,
        idempotencyKey,
        providerMessageId: existing.providerMessageId || null,
      });
      // Re-queue is idempotent via providerMessageId uniqueness in the spool.
      if (existing.providerMessageId) {
        await queueApiOutboundObservation({
          accountKey,
          phone,
          message,
          providerMessageId: existing.providerMessageId,
          observeApiOutbound,
          logger,
        });
      }
      return {
        success: true,
        status: 'duplicate',
        messageId: existing.providerMessageId || null,
        idempotencyKey,
        httpStatus: 200,
      };
    }

    if (existing.state === STATES.SENDING) {
      logOutbound(logger, 'unknown_result', {
        accountKey,
        idempotencyKey,
      });
      return {
        success: false,
        status: 'unknown',
        code: 'OUTBOUND_RESULT_UNKNOWN',
        idempotencyKey,
        error: 'Outbound send result is unknown; will not auto-resend',
        httpStatus: 409,
      };
    }
  }

  store.reserveSending({
    idempotencyKey,
    phone: String(phone || ''),
    payloadHash,
  });
  logOutbound(logger, 'reserved', {
    accountKey,
    idempotencyKey,
  });

  const started = Date.now();
  let result;
  try {
    result = await sendFn(phone, message);
  } catch (err) {
    // Unexpected throw: preserve SENDING unless caller marked definitive pre-send.
    if (err && err.sendAttempted === false) {
      store.clearSending(idempotencyKey);
      throw err;
    }
    logOutbound(logger, 'ambiguous_preserved', {
      accountKey,
      idempotencyKey,
    });
    return {
      success: false,
      status: 'unknown',
      code: 'OUTBOUND_RESULT_UNKNOWN',
      idempotencyKey,
      error: 'Outbound send result is unknown; will not auto-resend',
      httpStatus: 409,
    };
  }

  if (!result || !result.success) {
    if (isAmbiguousSendResult(result)) {
      logOutbound(logger, 'ambiguous_preserved', {
        accountKey,
        idempotencyKey,
      });
      return {
        success: false,
        status: 'unknown',
        code: 'OUTBOUND_RESULT_UNKNOWN',
        idempotencyKey,
        error: (result && result.error)
          || 'Outbound send result is unknown; will not auto-resend',
        httpStatus: 409,
      };
    }

    if (isDefinitivePreSendFailure(result)) {
      store.clearSending(idempotencyKey);
      return {
        ...(result || {
          success: false,
          status: 'failed',
          error: 'send_failed',
          code: 'SEND_FAILED',
        }),
        idempotencyKey,
        httpStatus: 409,
      };
    }

    // Unclassified failure after reservation: preserve (never auto-resend).
    logOutbound(logger, 'ambiguous_preserved', {
      accountKey,
      idempotencyKey,
    });
    return {
      success: false,
      status: 'unknown',
      code: 'OUTBOUND_RESULT_UNKNOWN',
      idempotencyKey,
      error: (result && result.error)
        || 'Outbound send result is unknown; will not auto-resend',
      httpStatus: 409,
    };
  }

  const messageId = result.messageId || null;
  if (!messageId) {
    logOutbound(logger, 'ambiguous_preserved', {
      accountKey,
      idempotencyKey,
    });
    return {
      success: false,
      status: 'unknown',
      code: 'OUTBOUND_RESULT_UNKNOWN',
      idempotencyKey,
      error: 'Outbound send completed without providerMessageId',
      httpStatus: 409,
    };
  }

  store.markSent({ idempotencyKey, providerMessageId: messageId });
  logOutbound(logger, 'sent', {
    accountKey,
    idempotencyKey,
    providerMessageId: messageId,
    latencyMs: Date.now() - started,
  });

  await queueApiOutboundObservation({
    accountKey,
    phone,
    message,
    providerMessageId: messageId,
    observeApiOutbound,
    logger,
  });

  return {
    success: true,
    status: 'sent',
    messageId,
    idempotencyKey,
    phone: result.phone,
    chatId: result.chatId,
    route: result.route,
    sendLatencyMs: result.sendLatencyMs,
    httpStatus: 200,
  };
}

module.exports = {
  sendManagedWithIdempotency,
  queueApiOutboundObservation,
  validateIdempotencyKey,
  isAmbiguousSendResult,
  isDefinitivePreSendFailure,
};
