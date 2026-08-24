const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const { renderTemplate } = require('../services/templateRenderer');
const { getTemplatesFile, getTemplateString, VALID_TYPES } = require('../services/templateStorage');
const { normalizeEgyptianPhone } = require('../services/phone');

const QUICK_MESSAGE_TYPE = 'quick_message';
/** POS-composed “أخرى”: template + fill happen in POS; bot only delivers `message`. */
const OTHER_TYPE = 'other';
const EMPLOYEE_DAILY_REPORT_TYPE = 'employee_daily_report';
const EMPLOYEE_FUNDING_TYPE = 'employee_funding';
const EMPLOYEE_SALE_TYPE = 'employee_sale';
/** Types that prefer an incoming `message` body (POS-composed text). */
const MESSAGE_FIRST_TYPES = [QUICK_MESSAGE_TYPE, OTHER_TYPE, EMPLOYEE_DAILY_REPORT_TYPE, EMPLOYEE_SALE_TYPE];
/** Types that require POS-composed message (no local template). */
const POS_MESSAGE_REQUIRED_TYPES = [QUICK_MESSAGE_TYPE, OTHER_TYPE];
const SENDABLE_TYPES = [...new Set([...VALID_TYPES, ...MESSAGE_FIRST_TYPES, EMPLOYEE_FUNDING_TYPE])];
const GENERIC_SEND_TYPE = 'generic';
const WA_DEBUG_FULL_PHONE = process.env.WHATSAPP_DEBUG_FULL_PHONE === 'true';

function maskPhone(phone) {
    const s = String(phone || '');
    if (WA_DEBUG_FULL_PHONE) return s;
    if (s.length <= 4) return '****';
    return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

function validateRequest(body) {
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
        return 'Request body is required';
    }

    const { type, phone, customerName, services, message } = body;

    if (!type) {
        return 'type is required';
    }

    if (!SENDABLE_TYPES.includes(type)) {
        return `type must be one of: ${SENDABLE_TYPES.join(', ')}`;
    }

    if (!phone) {
        return 'phone is required';
    }

    const normalizedPhone = normalizeEgyptianPhone(phone);
    if (!normalizedPhone) {
        return 'phone is invalid. Please provide a valid Egyptian mobile number';
    }

    if (!customerName || typeof customerName !== 'string' || customerName.trim().length === 0) {
        return 'customerName is required';
    }

    if (POS_MESSAGE_REQUIRED_TYPES.includes(type)) {
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return `message is required for ${type}`;
        }
        return null;
    }

    if (type === EMPLOYEE_DAILY_REPORT_TYPE) {
        const hasMessage = message && typeof message === 'string' && message.trim().length > 0;
        if (!hasMessage && !getTemplateString(type)) {
            return 'message is required for employee_daily_report (or save a template)';
        }
        return null;
    }

    if (type === EMPLOYEE_FUNDING_TYPE) {
        if (body.amount === null || body.amount === undefined || body.amount === '') {
            return 'amount is required for employee_funding';
        }
        if (Number.isNaN(Number(body.amount))) {
            return 'amount must be a number for employee_funding';
        }
        return null;
    }

    if (services !== undefined && !Array.isArray(services)) {
        return 'services must be an array';
    }

    return null;
}

function validateGenericRequest(body) {
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
        return 'Request body is required';
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

    return null;
}

/**
 * Build employee_funding WhatsApp text from POS fields.
 * Separate from employee_advance (ADV- / سلفة) — uses إيراد + FUND- style numbers.
 */
function buildEmployeeFundingMessage({ customerName, invoiceNumber, amount, paymentMethod, branchName, notes }) {
    const lines = [
        `أهلاً ${customerName.trim()} 👋`,
        '',
        'تم تسجيل إيراد جديد لك:',
        `المبلغ: ${amount} ج.م`
    ];

    if (invoiceNumber !== null && invoiceNumber !== undefined && String(invoiceNumber).trim()) {
        lines.push(`رقم العملية: ${String(invoiceNumber).trim()}`);
    }
    if (paymentMethod !== null && paymentMethod !== undefined && String(paymentMethod).trim()) {
        lines.push(`طريقة الدفع: ${String(paymentMethod).trim()}`);
    }
    if (branchName !== null && branchName !== undefined && String(branchName).trim()) {
        lines.push(`الفرع: ${String(branchName).trim()}`);
    }

    if (notes !== null && notes !== undefined && String(notes).trim()) {
        lines.push('', `ملاحظات: ${String(notes).trim()}`);
    }

    lines.push('', 'بالتوفيق! 💈');
    return lines.join('\n');
}

function buildTemplateData(req, customerName, normalizedPhone) {
    return {
        customerName: customerName.trim(),
        phone: normalizedPhone,
        invoiceNumber: req.body.invoiceNumber,
        orderId: req.body.orderId,
        total: req.body.total,
        amount: req.body.amount,
        currency: req.body.currency,
        paymentMethod: req.body.paymentMethod,
        branchName: req.body.branchName,
        employeeName: req.body.employeeName || customerName.trim(),
        services: req.body.services,
        service: req.body.service,
        bookingId: req.body.bookingId,
        bookingDate: req.body.bookingDate,
        date: req.body.date || req.body.workDate,
        bookingTime: req.body.bookingTime,
        time: req.body.time,
        barberName: req.body.barberName,
        bookingLink: req.body.bookingLink,
        notes: req.body.notes,
        workDate: req.body.workDate,
        checkIn: req.body.checkIn,
        checkOut: req.body.checkOut,
        actualHours: req.body.actualHours,
        scheduledHours: req.body.scheduledHours,
        statusLabelAr: req.body.statusLabelAr,
        lateMinutes: req.body.lateMinutes,
        baseWage: req.body.baseWage,
        fullDayBase: req.body.fullDayBase,
        baseWageNoteAr: req.body.baseWageNoteAr,
        targetSales: req.body.targetSales,
        targetAmount: req.body.targetAmount,
        deductions: req.body.deductions,
        advances: req.body.advances,
        dayNet: req.body.dayNet,
        ledgerBalance: req.body.ledgerBalance,
        payrollMonth: req.body.payrollMonth
    };
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

async function handleTypedSend(req, res) {
    try {
        const validationError = validateRequest(req.body);
        if (validationError) {
            return res.status(400).json({
                success: false,
                error: validationError
            });
        }

        const { type, customerName } = req.body;
        const normalizedPhone = normalizeEgyptianPhone(req.body.phone);
        const incomingMessage = typeof req.body.message === 'string' ? req.body.message.trim() : '';

        // employee_funding: compose message in-script (not employee_advance template)
        if (type === EMPLOYEE_FUNDING_TYPE) {
            const message = buildEmployeeFundingMessage({
                customerName,
                invoiceNumber: req.body.invoiceNumber,
                amount: req.body.amount,
                paymentMethod: req.body.paymentMethod,
                branchName: req.body.branchName,
                notes: req.body.notes
            });

            console.log('[WhatsApp Employee Funding]', {
                type,
                phone: normalizedPhone,
                customerName: customerName.trim(),
                invoiceNumber: req.body.invoiceNumber,
                amount: req.body.amount,
                branchName: req.body.branchName
            });

            return await sendAndRespond(res, {
                type,
                normalizedPhone,
                message,
                templateSource: EMPLOYEE_FUNDING_TYPE,
                meta: {
                    invoice: req.body.invoiceNumber,
                    empId: req.body.employeeId,
                },
            });
        }

        // Prefer POS-composed text for quick_message / other / employee_daily_report / employee_sale
        if (MESSAGE_FIRST_TYPES.includes(type) && incomingMessage) {
            console.log('[WhatsApp Message-First]', {
                type,
                phone: maskPhone(normalizedPhone),
                customerName: customerName.trim(),
                branchName: req.body.branchName,
                workDate: req.body.workDate,
                messageLength: incomingMessage.length
            });

            return await sendAndRespond(res, {
                type,
                normalizedPhone,
                message: incomingMessage,
                templateSource: type,
                meta: {
                    invoice: req.body.invoiceNumber,
                    empId: req.body.employeeId,
                },
            });
        }

        // Explicitly ignore any incoming message override for template-based types
        // (except message-first types which already handled above).
        if (req.body.message !== undefined && !MESSAGE_FIRST_TYPES.includes(type)) {
            console.warn(`[WhatsApp Send] Ignored incoming 'message' override for type=${type}, phone=${maskPhone(normalizedPhone)}`);
        }

        const template = getTemplateString(type);
        if (!template) {
            return res.status(500).json({
                success: false,
                error: `Template '${type}' is not available`
            });
        }

        const message = renderTemplate(template, buildTemplateData(req, customerName, normalizedPhone));

        console.log('[WhatsApp Template]', {
            type,
            templateFile: getTemplatesFile(),
            templateText: template,
            renderedMessage: message,
            hasIncomingMessageOverride: Boolean(req.body.message)
        });

        return await sendAndRespond(res, {
            type,
            normalizedPhone,
            message,
            templateSource: getTemplatesFile(),
            meta: {
                invoice: req.body.invoiceNumber,
                empId: req.body.employeeId,
            },
        });
    } catch (error) {
        console.error('Error in WhatsApp typed send:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send the WhatsApp message. Please try again.'
        });
    }
}

async function handleGenericSend(req, res) {
    try {
        const validationError = validateGenericRequest(req.body);
        if (validationError) {
            return res.status(400).json({
                success: false,
                error: validationError
            });
        }

        const normalizedPhone = normalizeEgyptianPhone(req.body.phone);
        const message = req.body.message.trim();
        const metadata = req.body.metadata;

        return await sendAndRespond(res, {
            type: GENERIC_SEND_TYPE,
            normalizedPhone,
            message,
            templateSource: GENERIC_SEND_TYPE,
            meta: metadata && typeof metadata === 'object' ? metadata : {},
        });
    } catch (error) {
        console.error('Error in WhatsApp generic send:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send the WhatsApp message. Please try again.'
        });
    }
}

function hasTypedSendType(body) {
    return body && typeof body === 'object' && body.type !== undefined && body.type !== null;
}

async function handleSend(req, res) {
    if (hasTypedSendType(req.body)) {
        return handleTypedSend(req, res);
    }
    return handleGenericSend(req, res);
}

/**
 * POST /api/whatsapp/send
 * Backward-compatible gateway: typed sends when `type` is present, generic send otherwise.
 * No authentication, no SQL Server, no campaigns, no offers, no SMS.
 */
router.post('/send', handleSend);

/**
 * POST /api/admin/whatsapp/test-send
 * Development alias for typed template sends (same behavior as /api/whatsapp/send).
 */
router.post('/test-send', handleTypedSend);

router.get('/status', async (req, res) => {
    try {
        const status = await whatsappService.getStatus();
        res.json(status);
    } catch (error) {
        console.error('Error in GET /api/whatsapp/status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to read WhatsApp status'
        });
    }
});

/**
 * POST /api/whatsapp/send-raw
 * Explicitly-named raw-message endpoint for development or special cases only.
 * The normal invoice flow must use POST /api/whatsapp/send, never this endpoint.
 */
router.post('/send-raw', async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({
                success: false,
                error: 'phone and message are required'
            });
        }

        const normalizedPhone = normalizeEgyptianPhone(phone);
        if (!normalizedPhone) {
            return res.status(400).json({
                success: false,
                error: 'phone is invalid. Please provide a valid Egyptian mobile number'
            });
        }

        const result = await whatsappService.sendMessageAndWait(normalizedPhone, message);
        if (!result.success) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp Web is not ready. Please scan the QR code and try again.',
                phone: normalizedPhone
            });
        }

        res.json({
            success: true,
            status: 'submitted',
            phone: normalizedPhone,
            message,
            templateSource: 'raw',
            sentAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in POST /api/whatsapp/send-raw:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send the WhatsApp message. Please try again.'
        });
    }
});

module.exports = router;
