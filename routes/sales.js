const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const smsService = require('../services/smsService');
const { renderTemplate } = require('../services/templateRenderer');
const { getTemplatesFile, getTemplateString, VALID_TYPES } = require('../services/templateStorage');

// Authentication token (should be in .env for production)
const API_TOKEN = process.env.SQL_TRIGGER_TOKEN || 'your-secret-token-change-this';

/**
 * Middleware to verify API token
 */
function verifyToken(req, res, next) {
    const token = req.headers['x-api-token'] || req.body.token || req.query.token;

    if (!token || token !== API_TOKEN) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized: Invalid or missing API token'
        });
    }

    next();
}

/**
 * Normalize data from the legacy /api/sales/notify saleData shape into the shared renderer shape.
 */
function normalizeSaleData(saleData, phone) {
    if (!saleData || typeof saleData !== 'object') {
        return {};
    }
    return {
        customerName: saleData.customerName || saleData.name,
        phone: phone || saleData.phone || saleData.customerPhone,
        orderId: saleData.orderId || saleData.saleId || saleData.reservationId,
        invoiceNumber: saleData.invoiceNumber || saleData.orderId || saleData.saleId,
        amount: saleData.amount || saleData.total,
        total: saleData.total || saleData.amount,
        currency: saleData.currency || saleData.currencyCode,
        date: saleData.date || saleData.saleDate || saleData.reservationDate || saleData.bookingDate,
        bookingDate: saleData.bookingDate || saleData.date || saleData.saleDate || saleData.reservationDate,
        time: saleData.time || saleData.reservationTime || saleData.bookingTime,
        bookingTime: saleData.bookingTime || saleData.time || saleData.reservationTime,
        paymentMethod: saleData.paymentMethod,
        service: saleData.service || saleData.serviceName,
        services: saleData.services || (saleData.service ? [saleData.service] : undefined),
        reservationId: saleData.reservationId,
        barberName: saleData.barberName || saleData.employeeName,
        employeeName: saleData.employeeName || saleData.barberName,
        branchName: saleData.branchName,
        bookingLink: saleData.bookingLink,
        notes: saleData.notes
    };
}

/**
 * POST /api/sales/notify
 * Endpoint called by SQL Server trigger when a new sale is inserted
 * 
 * Expected body:
 * {
 *   "phone": "201234567890",
 *   "message": "Custom message" OR "template": "template-name",
 *   "saleData": {
 *     "orderId": "12345",
 *     "amount": "100.00",
 *     "currency": "EGP",
 *     "customerName": "John Doe",
 *     ...
 *   }
 * }
 */
router.post('/notify', verifyToken, async (req, res) => {
    // Log that request was received
    console.log(`📥 Received notification request at ${new Date().toISOString()}`);

    // Set timeout for response (5 seconds max)
    req.setTimeout(5000);

    try {
        const { phone, message, template, saleData, type } = req.body;
        const notificationType = (type || 'sale').toLowerCase();

        console.log(`📱 Processing ${notificationType} notification for phone: ${phone}`);

        // Reject unsupported types
        if (!VALID_TYPES.includes(notificationType)) {
            return res.status(400).json({
                success: false,
                error: `type must be one of: ${VALID_TYPES.join(', ')}`
            });
        }

        // Validate required fields
        if (!phone) {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required'
            });
        }

        // The production endpoint must never accept a raw message override.
        // The message always comes from the saved template in data/templates.json.
        if (message !== undefined) {
            console.warn(`[Sales Notify] Ignored incoming 'message' override for type=${notificationType}, phone=${phone}`);
        }
        if (template !== undefined) {
            console.warn(`[Sales Notify] Ignored incoming 'template' override for type=${notificationType}, phone=${phone}`);
        }

        const savedTemplate = getTemplateString(notificationType);
        if (!savedTemplate) {
            return res.status(500).json({
                success: false,
                error: `Template '${notificationType}' is not available`
            });
        }

        const data = normalizeSaleData(saleData, phone);

        // customerName is required by the shared renderer
        if (!data.customerName || String(data.customerName).trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'customerName is required'
            });
        }

        const messageToSend = renderTemplate(savedTemplate, data);

        console.log('[WhatsApp Template]', {
            type: notificationType,
            templateFile: getTemplatesFile(),
            templateText: savedTemplate,
            renderedMessage: messageToSend,
            hasIncomingMessageOverride: Boolean(message)
        });

        // Send WhatsApp message in background (fire and forget)
        // Don't await - just call it and return immediately
        whatsappService.sendMessage(phone, messageToSend).catch(err => {
            console.error('Error in background WhatsApp send:', err);
        });

        // For first-time customers, also send SMS using the same rendered message
        if (notificationType === 'first_time') {
            const smsText = messageToSend
                .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/gu, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            smsService.sendSMS(phone, smsText).catch(err => {
                console.error('Error in background SMS send:', err);
            });
            console.log(`📱 SMS also queued for first-time customer: ${phone}`);
        }

        // Respond immediately without waiting
        console.log(`✅ Sending immediate response for phone: ${phone}`);

        res.json({
            success: true,
            message: 'Request accepted, message will be sent',
            queued: true,
            phone: phone,
            renderedMessage: messageToSend,
            templateSource: getTemplatesFile(),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in /api/sales/notify:', error);
        // Always respond, even on error
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
});

/**
 * POST /api/sales/send-message
 * Deprecated: raw-message endpoint for backward compatibility.
 * New callers should use POST /api/whatsapp/send-raw instead.
 */
router.post('/send-message', verifyToken, async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({
                success: false,
                error: 'Phone and message are required'
            });
        }

        console.warn('[Sales send-message] Deprecated endpoint called, use POST /api/whatsapp/send-raw instead');

        // Send in background (same fire-and-forget pattern as /notify)
        whatsappService.sendMessage(phone, message).catch(err => {
            console.error('Error in background WhatsApp send:', err);
        });

        res.json({
            success: true,
            message: 'Request accepted, message will be sent',
            queued: true,
            phone,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in /api/sales/send-message:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
});

/**
 * GET /api/sales/status
 * Check if WhatsApp service is ready
 */
router.get('/status', verifyToken, async (req, res) => {
    try {
        const isReady = await whatsappService.isReady();
        res.json({
            success: true,
            ready: isReady,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/sales/reinitialize
 * Reinitialize WhatsApp connection (if it's lost)
 */
router.post('/reinitialize', verifyToken, async (req, res) => {
    try {
        await whatsappService.reinitialize();
        res.json({
            success: true,
            message: 'WhatsApp connection reinitialized',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/sales/queue-status
 * Check queue status and WhatsApp readiness
 */
router.get('/queue-status', verifyToken, async (req, res) => {
    try {
        const isReady = await whatsappService.isReady();
        const queueInfo = whatsappService.getQueueInfo();
        
        res.json({
            success: true,
            whatsappReady: isReady,
            queue: queueInfo,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/sales/process-queue
 * Manually trigger queue processing
 */
router.post('/process-queue', verifyToken, async (req, res) => {
    try {
        whatsappService.processQueue();
        res.json({
            success: true,
            message: 'Queue processing triggered',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/sales/reset
 * Reset WhatsApp initialization (useful if stuck)
 */
router.post('/reset', verifyToken, async (req, res) => {
    try {
        await whatsappService.reinitialize();
        res.json({
            success: true,
            message: 'WhatsApp service reset and reinitializing',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/sales/cleanup
 * Clear in-memory state. The persistent Chrome profile is preserved.
 */
router.post('/cleanup', verifyToken, async (req, res) => {
    try {
        whatsappService.cleanup();
        res.json({
            success: true,
            message: 'Cleanup completed - in-memory state cleared, persistent profile preserved',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;

