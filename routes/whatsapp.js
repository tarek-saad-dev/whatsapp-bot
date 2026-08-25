const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const { normalizeEgyptianPhone } = require('../services/phone');
const { sendGenericWithIdempotency } = require('../services/idempotency/genericIdempotentSend');

const GENERIC_SEND_TYPE = 'generic';
const WA_DEBUG_FULL_PHONE = process.env.WHATSAPP_DEBUG_FULL_PHONE === 'true';

const TYPED_SEND_REMOVED_ERROR =
    'Typed sends are no longer supported on this gateway. ' +
    'Use the generic contract: { phone, message, metadata?, idempotencyKey? }. ' +
    'Compose message text in the ERP Messaging Module.';

function maskPhone(phone) {
    const s = String(phone || '');
    if (WA_DEBUG_FULL_PHONE) return s;
    if (s.length <= 4) return '****';
    return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

function validateGenericRequest(body) {
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
        return 'Request body is required';
    }

    if (body.type !== undefined && body.type !== null) {
        return TYPED_SEND_REMOVED_ERROR;
    }

    const { phone, message, metadata } = body;

    if (!phone) {
        return 'phone is required';
    }

    const normalizedPhone = normalizeEgyptianPhone(phone);
    if (!normalizedPhone) {
        return 'phone is invalid. Please provide a valid Egyptian mobile number';
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return 'message is required';
    }

    if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))) {
        return 'metadata must be an object';
    }

    const { idempotencyKey } = body;
    if (idempotencyKey !== undefined && idempotencyKey !== null) {
        if (typeof idempotencyKey !== 'string') {
            return 'idempotencyKey must be a string';
        }
        const trimmedKey = idempotencyKey.trim();
        if (trimmedKey.length === 0) {
            return 'idempotencyKey must be non-empty';
        }
        if (trimmedKey.length > 200) {
            return 'idempotencyKey must be at most 200 characters';
        }
    }

    return null;
}

async function sendAndRespond(res, { type, normalizedPhone, message, templateSource, meta = {} }) {
    const invoice = meta.invoice || meta.invoiceNumber || null;
    const empId = meta.empId != null ? meta.empId : meta.employeeId;
    console.log(
        `[whatsapp] ${type} request accepted` +
            (invoice ? ` invoice=${invoice}` : '') +
            (empId != null ? ` empId=${empId}` : '') +
            ` phone=${maskPhone(normalizedPhone)}`,
    );

    const result = await whatsappService.sendMessageAndWait(normalizedPhone, message, 120000, {
        logContext: {
            type,
            invoice,
            empId,
        },
    });

    if (result && result.status === 'not_registered') {
        console.log(
            `[whatsapp] ${type} failed` +
                (invoice ? ` invoice=${invoice}` : '') +
                (empId != null ? ` empId=${empId}` : '') +
                ` phone=${maskPhone(normalizedPhone)} error=not_registered`,
        );
        return res.status(400).json({
            ok: false,
            success: false,
            status: 'not_registered',
            phone: normalizedPhone,
            error: result.error || 'Phone number is not registered on WhatsApp',
        });
    }

    if (!result || !result.success || result.status === 'failed') {
        console.log(
            `[whatsapp] ${type} failed` +
                (invoice ? ` invoice=${invoice}` : '') +
                (empId != null ? ` empId=${empId}` : '') +
                ` phone=${maskPhone(normalizedPhone)} error=${(result && result.error) || 'unknown'}`,
        );
        return res.status(503).json({
            ok: false,
            success: false,
            status: 'failed',
            phone: normalizedPhone,
            error: (result && result.error) || 'WhatsApp Web is not ready. Please scan the QR code and try again.',
        });
    }

    if (!result.messageId) {
        console.log(
            `[whatsapp] ${type} failed` +
                (invoice ? ` invoice=${invoice}` : '') +
                ` phone=${maskPhone(normalizedPhone)} error=missing_message_id`,
        );
        return res.status(500).json({
            ok: false,
            success: false,
            status: 'failed',
            phone: normalizedPhone,
            error: 'Send completed without messageId',
        });
    }

    console.log(
        `[whatsapp] ${type} sent` +
            (invoice ? ` invoice=${invoice}` : '') +
            (empId != null ? ` empId=${empId}` : '') +
            ` phone=${maskPhone(normalizedPhone)} messageId=${result.messageId}`,
    );

    return res.json({
        ok: true,
        success: true,
        status: 'sent',
        messageId: result.messageId,
        type,
        phone: normalizedPhone,
        message,
        templateSource,
        sentAt: new Date().toISOString(),
    });
}

async function handleGenericSend(req, res) {
    try {
        const validationError = validateGenericRequest(req.body);
        if (validationError) {
            return res.status(400).json({
                success: false,
                error: validationError,
            });
        }

        const normalizedPhone = normalizeEgyptianPhone(req.body.phone);
        const message = req.body.message.trim();
        const metadata = req.body.metadata;
        const idempotencyKey = typeof req.body.idempotencyKey === 'string'
            ? req.body.idempotencyKey.trim()
            : '';

        if (!idempotencyKey) {
            return await sendAndRespond(res, {
                type: GENERIC_SEND_TYPE,
                normalizedPhone,
                message,
                templateSource: GENERIC_SEND_TYPE,
                meta: metadata && typeof metadata === 'object' ? metadata : {},
            });
        }

        const result = await sendGenericWithIdempotency({
            idempotencyKey,
            normalizedPhone,
            message,
            metadata: metadata && typeof metadata === 'object' ? metadata : {},
            sendAndWait: (...args) => whatsappService.sendMessageAndWait(...args),
            isReady: () => whatsappService.isReady(),
            ensureReady: () => whatsappService.getOrCreateDriver(),
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Error in WhatsApp generic send:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send the WhatsApp message. Please try again.',
        });
    }
}

/**
 * POST /api/whatsapp/send
 * Generic gateway: { phone, message, metadata?, idempotencyKey? }
 */
router.post('/send', handleGenericSend);

router.get('/status', async (req, res) => {
    try {
        const status = await whatsappService.getStatus();
        res.json(status);
    } catch (error) {
        console.error('Error in GET /api/whatsapp/status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to read WhatsApp status',
        });
    }
});

module.exports = router;
