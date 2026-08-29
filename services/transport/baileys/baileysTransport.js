'use strict';

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { createInboxSpool } = require('../../inbox/inboxSpool');
const { createInboxDeliveryWorker } = require('../../inbox/inboxDeliveryWorker');
const { utcNow, isoBetween } = require('../../inbox/inboxTiming');
const { logInbox } = require('../../inbox/inboxLogger');
const {
    shouldProcessUpsert,
    mapBaileysInbound,
    createLidPhoneCache,
} = require('./baileysMessageAdapter');
const { createLidMappingStore } = require('./lidMappingStore');
const { createOutboundMessageStore } = require('./outboundMessageStore');
const { resolveOutboundJid } = require('./resolveOutboundJid');
const {
    installLibsignalSessionLogSilence,
    getSessionChurnStats,
} = require('./silenceLibsignalSessionLogs');

const AUTH_DIR = process.env.BAILEYS_AUTH_DIR
    || path.join(process.cwd(), 'data', 'baileys-auth');
const LID_MAP_FILE = process.env.BAILEYS_LID_MAP_FILE
    || path.join(process.cwd(), 'data', 'lid-phone-map.json');

function createBaileysTransport({
    authDir = AUTH_DIR,
    lidMapFile = LID_MAP_FILE,
    spool = createInboxSpool(),
    deliveryWorker = null,
    includeGroups = process.env.WHATSAPP_INBOX_INCLUDE_GROUPS === 'true',
    logger = console,
    makeSocket = makeWASocket,
    useAuthState = useMultiFileAuthState,
    fetchVersion = fetchLatestBaileysVersion,
    outboundStore = null,
} = {}) {
    fs.mkdirSync(authDir, { recursive: true });

    installLibsignalSessionLogSilence({ logger });

    const worker = deliveryWorker || createInboxDeliveryWorker({ spool });
    const messageStore = outboundStore || createOutboundMessageStore();
    let sock = null;
    let saveCredsFn = null;
    let ready = false;
    let qrRequired = false;
    let lastError = null;
    let lastEventAt = null;
    let lastCapturedCount = 0;
    let reconnectAttempts = 0;
    let unresolvedLidCount = 0;
    let lastConnectedAt = null;
    let lastDisconnectAt = null;
    let stopping = false;
    let listening = false;
    let reconnectTimer = null;
    let connectGeneration = 0;
    let messagesUpsertListeners = 0;
    let messagesUpdateListeners = 0;
    let messageReceiptListeners = 0;
    let authLoaded = false;
    let getMessageStoreInitialized = true;
    let lastOutboundAt = null;
    let lastOutboundAckAt = null;
    let lastOutboundProviderMessageId = null;
    let lastOutboundRoute = null;
    let lastOutboundRemoteJid = null;
    const seenKeys = new Set();
    const lidStore = createLidMappingStore({ mapFile: lidMapFile });
    const lidCache = createLidPhoneCache(lidStore);

    function getDiagnostics() {
        const storeStats = messageStore.getStats();
        return {
            connectGeneration,
            messagesUpsertListeners,
            messagesUpdateListeners,
            messageReceiptListeners,
            reconnectAttempts,
            seenKeyCount: seenKeys.size,
            lidMappings: lidCache.size(),
            unresolvedLidCount,
            lidMapFile,
            authDir,
            authLoaded,
            getMessageStoreInitialized,
            getMessageStoreSize: storeStats.size,
            outboundMessageStore: storeStats,
            signalSessionChurn: getSessionChurnStats(),
            lastOutboundAt,
            lastOutboundAckAt,
            lastOutboundProviderMessageId,
            lastOutboundRoute,
            lastOutboundRemoteJid,
        };
    }

    function getInboxStatus() {
        const deliveryStats = spool.getStats();
        const recent = spool.listRecent(1);
        return {
            listening: listening && ready && !stopping,
            mode: 'baileys',
            triggerInstalled: false,
            lastPollAt: lastEventAt,
            lastError,
            lastCapturedCount,
            delivery: deliveryStats,
            deliveryWorker: worker.getStatus(),
            count: deliveryStats.pending + deliveryStats.delivered + deliveryStats.failedOrRetrying,
            lastText: recent[0] ? recent[0].text : null,
        };
    }

    function getStatus() {
        return {
            success: true,
            transport: 'baileys',
            ready,
            connected: ready,
            qrRequired,
            reconnectAttempts,
            lastConnectedAt,
            lastDisconnectAt,
            lidMappings: lidCache.size(),
            unresolvedLidCount,
            authLoaded,
            authDir,
            whatsappReady: ready,
            chromeConnected: false,
            whatsappTabFound: false,
            seleniumDriverAttached: false,
            diagnostics: getDiagnostics(),
            inbox: getInboxStatus(),
        };
    }

    async function teardownSocket() {
        const current = sock;
        sock = null;
        if (!current) return;
        try {
            current.ev.removeAllListeners('connection.update');
            current.ev.removeAllListeners('messages.upsert');
            current.ev.removeAllListeners('messages.update');
            current.ev.removeAllListeners('message-receipt.update');
            current.ev.removeAllListeners('creds.update');
            current.ev.removeAllListeners('contacts.upsert');
            current.ev.removeAllListeners('contacts.update');
            current.ev.removeAllListeners('chats.phoneNumberShare');
            current.ev.removeAllListeners('chats.upsert');
            current.ev.removeAllListeners('chats.update');
            current.ev.removeAllListeners('messaging-history.set');
            await current.end(undefined);
        } catch (_) {
            // ignore teardown errors
        }
    }

    function clearReconnectTimer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function handleOutboundUpdates(updates, generation) {
        if (generation !== connectGeneration || sock === null) return;
        for (const item of updates || []) {
            const key = item && item.key;
            if (!key || !key.fromMe) continue; // outbound only — never inbound enqueue
            const update = item.update || {};
            const at = utcNow();
            if (update.status != null) {
                lastOutboundAckAt = at;
                if (key.id) lastOutboundProviderMessageId = key.id;
                if (key.remoteJid) lastOutboundRemoteJid = key.remoteJid;
            }
            logInbox('baileys_outbound_update', {
                providerMessageId: key.id || null,
                remoteJid: key.remoteJid || null,
                status: update.status != null ? update.status : null,
                at,
            });
        }
    }

    function handleOutboundReceipts(receipts, generation) {
        if (generation !== connectGeneration || sock === null) return;
        for (const item of receipts || []) {
            const key = item && item.key;
            if (!key || !key.fromMe) continue; // outbound only
            const receipt = item.receipt || {};
            logInbox('baileys_outbound_receipt', {
                providerMessageId: key.id || null,
                remoteJid: key.remoteJid || null,
                receiptTimestamp: receipt.receiptTimestamp || null,
                readTimestamp: receipt.readTimestamp || null,
                playedTimestamp: receipt.playedTimestamp || null,
                at: utcNow(),
            });
        }
    }

    async function handleMessagesUpsert(upsert, generation) {
        if (generation !== connectGeneration || sock === null) return;

        const gate = shouldProcessUpsert(upsert);
        if (!gate.accept) {
            const sample = (upsert.messages || []).slice(0, 5).map((msg) => ({
                id: msg?.key?.id || null,
                fromMe: Boolean(msg?.key?.fromMe),
                remoteJid: msg?.key?.remoteJid || null,
                senderPn: msg?.key?.senderPn || null,
                text: String(
                    msg?.message?.conversation
                    || msg?.message?.extendedTextMessage?.text
                    || '',
                ).slice(0, 80),
            }));
            logInbox('baileys_upsert_ignored', {
                reason: gate.reason,
                type: upsert.type,
                count: (upsert.messages || []).length,
                sample,
            });
            return;
        }

        const waDetectedAt = utcNow();
        for (const msg of upsert.messages || []) {
            const captureStartedAt = utcNow();
            const mapped = mapBaileysInbound(msg, { includeGroups, seenKeys, lidCache });
            if (mapped.action === 'duplicate') {
                logInbox('baileys_duplicate_ignored', { dedupeKey: mapped.dedupeKey });
                continue;
            }
            if (mapped.action !== 'capture') {
                if (mapped.reason === 'unresolved_lid') {
                    unresolvedLidCount += 1;
                }
                logInbox('baileys_inbound_ignored', {
                    reason: mapped.reason,
                    remoteJid: mapped.remoteJid,
                    customerJid: mapped.customerJid,
                });
                continue;
            }

            const captureCompletedAt = utcNow();
            const msgTsMs = Number(msg.messageTimestamp)
                ? Number(msg.messageTimestamp) * 1000
                : Date.parse(waDetectedAt);
            const timing = {
                waDetectedAt,
                captureStartedAt,
                captureCompletedAt,
                captureLatencyMs: isoBetween(captureStartedAt, captureCompletedAt),
                endToEndLatencyMs: Math.max(0, Date.parse(captureCompletedAt) - msgTsMs),
                browserQueueWaitMs: 0,
                browserOperationMs: 0,
            };

            if (spool.hasProviderMessageId(mapped.providerMessageId)) {
                logInbox('baileys_spool_duplicate', { providerMessageId: mapped.providerMessageId });
                continue;
            }

            spool.capture(mapped.normalized, { timing });
            lastEventAt = captureCompletedAt;
            lastCapturedCount += 1;
            lastError = null;

            logInbox('baileys_captured', {
                providerMessageId: mapped.providerMessageId,
                phone: mapped.phone,
                captureLatencyMs: timing.captureLatencyMs,
            });

            await worker.tick();
        }
    }

    async function connect() {
        stopping = false;
        clearReconnectTimer();
        await teardownSocket();

        const generation = ++connectGeneration;
        const { state, saveCreds } = await useAuthState(authDir);
        saveCredsFn = saveCreds;
        authLoaded = Boolean(state && state.creds);
        const { version } = await fetchVersion();

        const socket = makeSocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            // Baileys 6.7.22: required for decrypt-retry ("this message can take a while")
            getMessage: async (key) => messageStore.getMessage(key),
        });
        sock = socket;

        socket.ev.on('creds.update', saveCreds);

        socket.ev.on('contacts.upsert', (contacts) => {
            for (const contact of contacts || []) {
                lidCache.rememberContact(contact, 'contacts.upsert');
            }
        });
        socket.ev.on('contacts.update', (contacts) => {
            for (const contact of contacts || []) {
                lidCache.rememberContact(contact, 'contacts.update');
            }
        });
        socket.ev.on('chats.upsert', (chats) => {
            for (const chat of chats || []) {
                lidCache.rememberChat(chat, 'chats.upsert');
            }
        });
        socket.ev.on('chats.update', (updates) => {
            for (const chat of updates || []) {
                lidCache.rememberChat(chat, 'chats.update');
            }
        });
        socket.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
            lidCache.rememberPn(lid, jid, 'chats.phoneNumberShare');
        });
        socket.ev.on('messaging-history.set', (payload) => {
            for (const contact of payload.contacts || []) {
                lidCache.rememberContact(contact, 'messaging-history.set.contact');
            }
            for (const chat of payload.chats || []) {
                lidCache.rememberChat(chat, 'messaging-history.set.chat');
            }
        });

        socket.ev.on('connection.update', (update) => {
            if (sock !== socket || generation !== connectGeneration) return;

            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                ready = false;
                qrRequired = true;
                logger.info('[baileys] QR required — scan with Linked devices on the salon phone');
                qrcode.generate(qr, { small: true });
            }
            if (connection === 'open') {
                ready = true;
                qrRequired = false;
                reconnectAttempts = 0;
                lastError = null;
                lastConnectedAt = new Date().toISOString();
                logger.info('[baileys] READY', { connectGeneration: generation });
            }
            if (connection === 'close') {
                ready = false;
                lastDisconnectAt = new Date().toISOString();
                const err = lastDisconnect && lastDisconnect.error;
                const statusCode = err && err.output && err.output.statusCode;
                const loggedOut = statusCode === DisconnectReason.loggedOut;
                lastError = (err && err.message) || `connection_closed:${statusCode}`;
                logger.warn('[baileys] connection_closed', { statusCode, loggedOut });

                if (!stopping && !loggedOut && sock === socket) {
                    reconnectAttempts += 1;
                    const delay = Math.min(30_000, 1000 * reconnectAttempts);
                    clearReconnectTimer();
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        connect().catch((connectErr) => {
                            lastError = connectErr.message || String(connectErr);
                            logger.error('[baileys] reconnect_failed', { error: lastError });
                        });
                    }, delay);
                }
            }
        });

        messagesUpsertListeners += 1;
        socket.ev.on('messages.upsert', (upsert) => {
            handleMessagesUpsert(upsert, generation).catch((err) => {
                lastError = err.message || String(err);
                logger.error('[baileys] upsert_failed', { error: lastError });
            });
        });

        messagesUpdateListeners += 1;
        socket.ev.on('messages.update', (updates) => {
            try {
                handleOutboundUpdates(updates, generation);
            } catch (err) {
                logger.error('[baileys] outbound_update_failed', {
                    error: err.message || String(err),
                });
            }
        });

        messageReceiptListeners += 1;
        socket.ev.on('message-receipt.update', (receipts) => {
            try {
                handleOutboundReceipts(receipts, generation);
            } catch (err) {
                logger.error('[baileys] outbound_receipt_failed', {
                    error: err.message || String(err),
                });
            }
        });

        return socket;
    }

    async function start() {
        listening = true;
        worker.start();
        await connect();
        return getStatus();
    }

    async function stop() {
        stopping = true;
        listening = false;
        ready = false;
        worker.stop();
        clearReconnectTimer();
        await teardownSocket();
        return getStatus();
    }

    async function send(phone, message) {
        if (!sock || !ready) {
            return {
                success: false,
                status: 'failed',
                error: 'WhatsApp transport is not ready. Please scan the QR code and try again.',
            };
        }

        const destination = resolveOutboundJid(phone, lidCache);
        if (!destination.ok) {
            return {
                success: false,
                status: 'failed',
                error: destination.error || 'invalid_phone',
            };
        }

        const jid = destination.jid;
        const text = String(message || '');
        const outboundContent = { conversation: text };
        const sendStartedAt = Date.now();
        try {
            logger.info('[baileys] send_start', {
                phone: destination.phone,
                remoteJid: jid,
                route: destination.route,
            });
            const result = await sock.sendMessage(jid, { text });
            const sendCompletedAt = Date.now();
            const messageId = result?.key?.id || null;
            const resultKey = result?.key || {
                remoteJid: jid,
                fromMe: true,
                id: messageId,
            };
            const storedContent = result?.message || outboundContent;
            if (messageId) {
                messageStore.put(resultKey, storedContent);
            }
            lastOutboundAt = utcNow();
            lastOutboundProviderMessageId = messageId;
            lastOutboundRoute = destination.route;
            lastOutboundRemoteJid = jid;
            logger.info('[baileys] send_end', {
                phone: destination.phone,
                remoteJid: jid,
                route: destination.route,
                providerMessageId: messageId,
                sendLatencyMs: sendCompletedAt - sendStartedAt,
                storedForRetry: Boolean(messageId),
            });
            return {
                success: true,
                status: 'sent',
                messageId,
                phone: destination.phone,
                chatId: jid,
                route: destination.route,
                sendLatencyMs: sendCompletedAt - sendStartedAt,
            };
        } catch (error) {
            lastError = error.message || String(error);
            logger.error('[baileys] send_failed', {
                phone: destination.phone,
                remoteJid: jid,
                route: destination.route,
                error: lastError,
            });
            return {
                success: false,
                status: 'failed',
                error: lastError,
                phone: destination.phone,
                chatId: jid,
                route: destination.route,
            };
        }
    }

    function isReady() {
        return ready;
    }

    return {
        start,
        stop,
        send,
        isReady,
        getStatus,
        getDiagnostics,
        getInboxStatus,
        connect,
        spool,
        deliveryWorker: worker,
        lidCache,
        lidStore,
        outboundStore: messageStore,
        resolveOutboundJid: (phone) => resolveOutboundJid(phone, lidCache),
    };
}

module.exports = {
    createBaileysTransport,
};
