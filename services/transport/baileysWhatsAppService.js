'use strict';

require('dotenv').config();

const { createSendQueue } = require('../sendQueue');
const { createBaileysTransport } = require('./baileys/baileysTransport');

const sendQueue = createSendQueue({ concurrency: 1 });
const transport = createBaileysTransport({ logger: console });

function formatPhoneNumber(phone) {
    return phone.toString().replace(/^0/, '20');
}

function maskPhone(phone) {
    const WA_DEBUG_FULL_PHONE = process.env.WHATSAPP_DEBUG_FULL_PHONE === 'true';
    const s = String(phone || '');
    if (WA_DEBUG_FULL_PHONE) return s;
    if (s.length <= 4) return '****';
    return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

function chatIdFromPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return `${digits}@c.us`;
}

async function sendMessageAndWait(phone, message, timeout = 120000, meta = {}) {
    const logCtx = meta.logContext || {};
    const typePrefix = logCtx.type || 'message';
    console.log(
        `[whatsapp/baileys] ${typePrefix} queued phone=${maskPhone(phone)}`,
    );

    return sendQueue.enqueue(async () => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (!transport.isReady()) {
                if (!transport.getStatus().qrRequired) {
                    try {
                        await transport.connect();
                    } catch (_) {
                        // retry below
                    }
                }
                if (Date.now() - start >= timeout) break;
                await new Promise((r) => setTimeout(r, 2000));
                continue;
            }

            const result = await transport.send(phone, message);
            if (result && result.success) {
                return {
                    success: true,
                    status: 'sent',
                    messageId: result.messageId || `wa-${Date.now()}-${String(phone).replace(/\D/g, '').slice(-8)}`,
                    phone: result.phone || formatPhoneNumber(phone),
                    chatId: result.chatId || chatIdFromPhone(phone),
                };
            }
            if (Date.now() - start >= timeout) {
                return {
                    success: false,
                    status: 'failed',
                    error: (result && result.error) || 'Send failed within timeout',
                    phone: formatPhoneNumber(phone),
                };
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
        return {
            success: false,
            status: 'failed',
            error: 'WhatsApp transport is not ready. Please scan the QR code and try again.',
            phone: formatPhoneNumber(phone),
        };
    });
}

async function sendMessage(phone, message) {
    if (transport.isReady()) {
        sendQueue.enqueue(() => transport.send(phone, message)).catch((error) => {
            console.log(`⚠️ Baileys send failed for ${maskPhone(phone)}:`, error.message);
        });
        return { success: true, message: 'Message sending in background', status: 'queued' };
    }
    transport.start().catch((err) => console.error('❌ Failed to start Baileys transport:', err.message));
    return {
        success: true,
        queued: true,
        status: 'queued',
        message: 'WhatsApp is not ready yet; initialize the session and retry',
    };
}

async function sendGroupMessageAndWait() {
    return {
        success: false,
        status: 'failed',
        error: 'Group send is not supported in Baileys transport mode. Use WHATSAPP_TRANSPORT=selenium.',
    };
}

async function sendGroupMessage() {
    return sendGroupMessageAndWait();
}

async function createGroupAndWait() {
    return {
        success: false,
        status: 'failed',
        error: 'Group create is not supported in Baileys transport mode. Use WHATSAPP_TRANSPORT=selenium.',
    };
}

async function initializeDriver() {
    await transport.start();
    return null;
}

async function getOrCreateDriver() {
    if (!transport.isReady()) {
        await transport.start();
    }
    return null;
}

async function isReady() {
    return transport.isReady();
}

async function getStatus() {
    const status = await transport.getStatus();
    const { shouldUseMemoryStore } = require('../idempotency/deliveryStore');
    status.idempotencyStore = shouldUseMemoryStore() ? 'memory' : 'sql';
    return status;
}

async function startInboxListener({ initDriver = false } = {}) {
    if (initDriver === false || initDriver === true) {
        // Baileys never uses Chrome — initDriver is ignored.
    }
    await transport.start();
    return transport.getInboxStatus();
}

function stopInboxListener() {
    // Fire-and-forget stop; return inbox-shaped status immediately for HTTP contract.
    transport.stop().catch(() => {});
    return {
        ...transport.getInboxStatus(),
        listening: false,
    };
}

function getInbox(limit) {
    const status = transport.getInboxStatus();
    return {
        ...status,
        messages: transport.spool.listRecent(Number(limit) || 50),
    };
}

async function pollInboxOnce() {
    await transport.deliveryWorker.tick();
    return transport.spool.listRecent(10);
}

async function reinitialize() {
    await transport.stop();
    return transport.start();
}

async function closeDriver() {
    await transport.stop();
}

function cleanup() {
    transport.stop().catch(() => {});
}

function resetWhatsAppSession() {
    console.warn('⚠️  resetWhatsAppSession for Baileys: stop transport and delete data/baileys-auth manually.');
    transport.stop().catch(() => {});
}

function getQueueInfo() {
    const stats = sendQueue.getStats();
    return {
        length: 0,
        isProcessing: stats.active > 0,
        driverInitialized: transport.isReady(),
        sendQueue: stats,
        messages: [],
    };
}

function processQueue() {
    console.log('🔧 Baileys mode has no legacy message queue');
}

function getSendQueueStats() {
    return sendQueue.getStats();
}

function resetSendQueueStats() {
    sendQueue.resetStats();
}

function enqueueSendTask(task) {
    return sendQueue.enqueue(task);
}

async function listWhatsAppPageTargets() {
    return [];
}

async function isDebugPortActive() {
    return false;
}

module.exports = {
    sendMessage,
    sendMessageAndWait,
    sendGroupMessage,
    sendGroupMessageAndWait,
    createGroupAndWait,
    initializeDriver,
    isReady,
    reinitialize,
    closeDriver,
    getQueueInfo,
    processQueue,
    cleanup,
    resetWhatsAppSession,
    getStatus,
    formatPhoneNumber,
    getOrCreateDriver,
    listWhatsAppPageTargets,
    isDebugPortActive,
    getSendQueueStats,
    resetSendQueueStats,
    enqueueSendTask,
    maskPhone,
    chatIdFromPhone,
    normalizeForWhatsApp: formatPhoneNumber,
    startInboxListener,
    stopInboxListener,
    getInbox,
    pollInboxOnce,
    _transport: transport,
};
