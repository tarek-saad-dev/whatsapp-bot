'use strict';

const { STATUSES, CODES } = require('./constants');
const { claimDelivery, recordSendOutcome } = require('./claimDelivery');
const { getDeliveryStore } = require('./deliveryStore');

const WA_DEBUG_FULL_PHONE = process.env.WHATSAPP_DEBUG_FULL_PHONE === 'true';

function maskPhone(phone) {
    const s = String(phone || '');
    if (WA_DEBUG_FULL_PHONE) return s;
    if (s.length <= 4) return '****';
    return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

function successBody({ phone, message, messageId, sentAt, idempotentReplay }) {
    return {
        ok: true,
        success: true,
        status: 'sent',
        messageId,
        type: 'generic',
        phone,
        message,
        templateSource: 'generic',
        sentAt,
        idempotentReplay,
    };
}

function errorBody({ status, error, code, extra = {} }) {
    return {
        status,
        body: {
            ok: false,
            success: false,
            error,
            code,
            ...extra,
        },
    };
}

/**
 * Generic send with durable idempotency. Caller must already have validated
 * phone/message/key. Typed legacy send must not use this path.
 */
async function sendGenericWithIdempotency({
    idempotencyKey,
    normalizedPhone,
    message,
    metadata,
    sendAndWait,
    isReady,
    ensureReady,
    now = new Date(),
    store = getDeliveryStore(),
}) {
    let claim;
    try {
        claim = await claimDelivery({
            idempotencyKey,
            normalizedPhone,
            trimmedMessage: message,
            now,
            store,
        });
    } catch (err) {
        console.error('[whatsapp] delivery ledger claim failed:', err && err.message);
        return errorBody({
            status: 503,
            error: 'Failed to record delivery claim. Please try again.',
            code: 'DELIVERY_LEDGER_UNAVAILABLE',
        });
    }

    if (claim.action === 'conflict') {
        return errorBody({
            status: 409,
            error: 'Idempotency key was already used with a different phone or message',
            code: CODES.IDEMPOTENCY_CONFLICT,
        });
    }

    if (claim.action === 'replay') {
        const sentAt = claim.row && claim.row.sentAt
            ? new Date(claim.row.sentAt).toISOString()
            : undefined;
        return {
            status: 200,
            body: successBody({
                phone: normalizedPhone,
                message,
                messageId: claim.row && claim.row.providerMessageId,
                sentAt,
                idempotentReplay: true,
            }),
        };
    }

    if (claim.action === 'in_progress') {
        return errorBody({
            status: 409,
            error: 'A send with this idempotency key is already in progress',
            code: CODES.IDEMPOTENCY_IN_PROGRESS,
            extra: { status: STATUSES.PROCESSING },
        });
    }

    if (claim.action === 'unknown') {
        return errorBody({
            status: 503,
            error: 'Delivery status is unknown and will not be retried automatically',
            code: CODES.DELIVERY_STATUS_UNKNOWN,
            extra: { status: STATUSES.UNKNOWN },
        });
    }

    if (claim.action !== 'send') {
        return errorBody({
            status: 503,
            error: 'Delivery status is unknown and will not be retried automatically',
            code: CODES.DELIVERY_STATUS_UNKNOWN,
            extra: { status: STATUSES.UNKNOWN },
        });
    }

    const invoice = metadata && (metadata.invoice || metadata.invoiceNumber || metadata.invoiceId);
    const empId = metadata && (metadata.empId != null ? metadata.empId : metadata.employeeId);
    console.log(
        `[whatsapp] generic request accepted` +
            (invoice ? ` invoice=${invoice}` : '') +
            (empId != null ? ` empId=${empId}` : '') +
            ` phone=${maskPhone(normalizedPhone)}` +
            ` idempotencyKey=${idempotencyKey}` +
            (claim.retry ? ' retry=1' : ''),
    );

    try {
        if (typeof ensureReady === 'function') {
            await ensureReady();
        }
        const ready = await isReady();
        if (!ready) {
            await recordSendOutcome({
                idempotencyKey,
                sendResult: { error: 'WhatsApp Web is not ready. Please scan the QR code and try again.' },
                preSendFailure: true,
                store,
                now,
            });
            return {
                status: 503,
                body: {
                    ok: false,
                    success: false,
                    status: 'failed',
                    phone: normalizedPhone,
                    error: 'WhatsApp Web is not ready. Please scan the QR code and try again.',
                    code: CODES.RETRYABLE_FAILED,
                },
            };
        }
    } catch (err) {
        const msg = String((err && err.message) || '');
        const preSend = /QR|not ready/i.test(msg);
        await recordSendOutcome({
            idempotencyKey,
            error: err,
            preSendFailure: preSend,
            store,
            now,
        });
        if (preSend) {
            return {
                status: 503,
                body: {
                    ok: false,
                    success: false,
                    status: 'failed',
                    phone: normalizedPhone,
                    error: 'WhatsApp Web is not ready. Please scan the QR code and try again.',
                    code: CODES.RETRYABLE_FAILED,
                },
            };
        }
        return errorBody({
            status: 503,
            error: 'Delivery status is unknown and will not be retried automatically',
            code: CODES.DELIVERY_STATUS_UNKNOWN,
            extra: { status: STATUSES.UNKNOWN },
        });
    }

    let sendResult;
    try {
        sendResult = await sendAndWait(normalizedPhone, message, 120000, {
            logContext: {
                type: 'generic',
                invoice: invoice || null,
                empId,
            },
        });
    } catch (err) {
        await recordSendOutcome({
            idempotencyKey,
            error: err,
            preSendFailure: false,
            store,
            now,
        });
        return errorBody({
            status: 503,
            error: 'Delivery status is unknown and will not be retried automatically',
            code: CODES.DELIVERY_STATUS_UNKNOWN,
            extra: { status: STATUSES.UNKNOWN },
        });
    }

    if (sendResult && sendResult.status === 'not_registered') {
        await recordSendOutcome({
            idempotencyKey,
            sendResult,
            preSendFailure: true,
            store,
            now,
        });
        return {
            status: 400,
            body: {
                ok: false,
                success: false,
                status: 'not_registered',
                phone: normalizedPhone,
                error: sendResult.error || 'Phone number is not registered on WhatsApp',
                code: CODES.RETRYABLE_FAILED,
            },
        };
    }

    const recorded = await recordSendOutcome({
        idempotencyKey,
        sendResult,
        preSendFailure: false,
        store,
        now,
    });

    if (recorded.ledgerStatus === STATUSES.SENT) {
        return {
            status: 200,
            body: successBody({
                phone: normalizedPhone,
                message,
                messageId: recorded.messageId,
                sentAt: new Date().toISOString(),
                idempotentReplay: false,
            }),
        };
    }

    return errorBody({
        status: 503,
        error: 'Delivery status is unknown and will not be retried automatically',
        code: CODES.DELIVERY_STATUS_UNKNOWN,
        extra: { status: STATUSES.UNKNOWN },
    });
}

module.exports = {
    sendGenericWithIdempotency,
};
