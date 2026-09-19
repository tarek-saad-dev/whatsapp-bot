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
    if (existing.state === STATES.SENT) {
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
      logOutbound(logger, 'duplicate', {
        accountKey,
        idempotencyKey,
        providerMessageId: existing.providerMessageId || null,
      });
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
    // Definitive failure before WhatsApp accept — clear reservation so a new key
    // or later explicit operator action can proceed. Ambiguous network after
    // accept is rare here; Baileys typically throws before returning an id.
    store.clearSending(idempotencyKey);
    throw err;
  }

  if (!result || !result.success) {
    store.clearSending(idempotencyKey);
    return {
      ...(result || {
        success: false,
        status: 'failed',
        error: 'send_failed',
        code: 'SEND_FAILED',
      }),
      idempotencyKey,
      httpStatus: result && result.code === 'NOT_READY' ? 409 : 409,
    };
  }

  const messageId = result.messageId || null;
  if (!messageId) {
    // Ambiguous: WhatsApp may have accepted without returning an id.
    logOutbound(logger, 'unknown_result', {
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
  validateIdempotencyKey,
};
