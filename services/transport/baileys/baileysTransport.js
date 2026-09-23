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
    mapBaileysOutboundObserved,
    createLidPhoneCache,
    buildRawUpsertSample,
} = require('./baileysMessageAdapter');
const { createLidMappingStore } = require('./lidMappingStore');
const { createOutboundMessageStore } = require('./outboundMessageStore');
const { createUnresolvedLidPendingBuffer } = require('./unresolvedLidPending');
const { createInboundQuarantineStore } = require('./inboundQuarantineStore');
const { resolveOutboundJid } = require('./resolveOutboundJid');
const { createOutboundObservedPoster } = require('../../inbox/outboundObservedPoster');
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
    quarantineFile = null,
    spool = createInboxSpool(),
    deliveryWorker = null,
    outboundObservedPoster = null,
    includeGroups = process.env.WHATSAPP_INBOX_INCLUDE_GROUPS === 'true',
    logger = console,
    makeSocket = makeWASocket,
    useAuthState = useMultiFileAuthState,
    fetchVersion = fetchLatestBaileysVersion,
    outboundStore = null,
    onLiveInbound = null,
    printQrToTerminal = true,
    onLoggedOut = null,
} = {}) {
    fs.mkdirSync(authDir, { recursive: true });

    installLibsignalSessionLogSilence({ logger });

    const worker = deliveryWorker || createInboxDeliveryWorker({ spool });
    const outboundPoster = outboundObservedPoster || createOutboundObservedPoster();
    const messageStore = outboundStore || createOutboundMessageStore();
    const inboundQuarantine = createInboundQuarantineStore({
        filePath: quarantineFile || path.join(authDir, 'inbound-quarantine.json'),
    });
    let sock = null;
    let saveCredsFn = null;
    let ready = false;
    let qrRequired = false;
    let lastQr = null;
    let loggedOut = false;
    let lastDisconnectCode = null;
    let lastError = null;
    let lastEventAt = null;
    let lastCapturedCount = 0;
    let reconnectAttempts = 0;
    let unresolvedLidCount = 0;
    let rawUpsertCount = 0;
    let emptyContentCount = 0;
    let inboundQuarantinedCount = 0;
    let decryptFailedCount = 0;
    let lastConnectedAt = null;
    let lastDisconnectAt = null;
    let stopping = false;
    let listening = false;
    let reconnectTimer = null;
    let connectGeneration = 0;
    let messagesUpsertListenersTotal = 0;
    let messagesUpdateListenersTotal = 0;
    let messageReceiptListenersTotal = 0;
    let currentSocketListenersAttached = {
        messagesUpsert: 0,
        messagesUpdate: 0,
        messageReceipt: 0,
    };
    let authLoaded = false;
    let getMessageStoreInitialized = true;
    let lastOutboundAt = null;
    let lastOutboundAckAt = null;
    let lastOutboundProviderMessageId = null;
    let lastOutboundRoute = null;
    let lastOutboundRemoteJid = null;
    const seenKeys = new Set();
    const seenOutboundKeys = new Set();
    const lidStore = createLidMappingStore({ mapFile: lidMapFile });
    const lidCache = createLidPhoneCache(lidStore);
    const lidPending = createUnresolvedLidPendingBuffer();
    const decryptPending = createUnresolvedLidPendingBuffer({
        timeoutMs: Number(process.env.BAILEYS_DECRYPT_PENDING_MS || 15000),
        retryOffsetsMs: (process.env.BAILEYS_DECRYPT_RETRY_OFFSETS_MS || '0,1000,3000,6000,10000')
            .split(',')
            .map((s) => Number(String(s).trim()))
            .filter((n) => Number.isFinite(n) && n >= 0),
    });

    function bumpLidLearned() {
        void reprocessPendingLidMessages();
        void reprocessDurableQuarantine({ reason: 'lid_mapping_learned' });
    }

    const _rememberPn = lidCache.rememberPn.bind(lidCache);
    lidCache.rememberPn = (lidJid, pnJid, source) => {
        const changed = _rememberPn(lidJid, pnJid, source);
        if (changed) bumpLidLearned();
        return changed;
    };
    const _rememberContact = lidCache.rememberContact.bind(lidCache);
    lidCache.rememberContact = (contact, source) => {
        _rememberContact(contact, source);
        bumpLidLearned();
    };
    const _rememberChat = lidCache.rememberChat.bind(lidCache);
    lidCache.rememberChat = (chat, source) => {
        _rememberChat(chat, source);
        bumpLidLearned();
    };

    function getCurrentSocketListenerCounts() {
        if (sock && sock.ev && typeof sock.ev.listenerCount === 'function') {
            return {
                messagesUpsert: sock.ev.listenerCount('messages.upsert'),
                messagesUpdate: sock.ev.listenerCount('messages.update'),
                messageReceipt: sock.ev.listenerCount('message-receipt.update'),
            };
        }
        return { ...currentSocketListenersAttached };
    }

    function getDiagnostics() {
        const storeStats = messageStore.getStats();
        const currentSocketListeners = getCurrentSocketListenerCounts();
        return {
            connectGeneration,
            currentSocketListeners,
            messagesUpsertListeners: currentSocketListeners.messagesUpsert,
            messagesUpdateListeners: currentSocketListeners.messagesUpdate,
            messageReceiptListeners: currentSocketListeners.messageReceipt,
            messagesUpsertListenersTotal,
            messagesUpdateListenersTotal,
            messageReceiptListenersTotal,
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
            inboundCapture: {
                rawUpsert: rawUpsertCount,
                captured: lastCapturedCount,
                unresolvedLid: unresolvedLidCount,
                decryptFailed: decryptFailedCount,
                emptyContent: emptyContentCount,
                quarantined: inboundQuarantinedCount,
                pendingLid: lidPending.size(),
                pendingDecrypt: decryptPending.size(),
                durableQuarantine: inboundQuarantine.size(),
            },
        };
    }

    function getStatus() {
        return {
            success: true,
            transport: 'baileys',
            ready,
            connected: ready,
            qrRequired,
            qrAvailable: Boolean(lastQr),
            loggedOut,
            lastDisconnectCode,
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

    /** Ephemeral QR payload — runtime memory only; never log the raw value. */
    function getQr() {
        return lastQr;
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
            currentSocketListenersAttached = {
                messagesUpsert: 0,
                messagesUpdate: 0,
                messageReceipt: 0,
            };
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

    function logRawUpsert(upsert, generation) {
        const messages = upsert?.messages || [];
        rawUpsertCount += 1;
        const sample = messages.slice(0, 5).map((msg) => buildRawUpsertSample(msg));
        logInbox('baileys_raw_upsert', {
            generation,
            upsertType: upsert?.type || null,
            count: messages.length,
            sample: JSON.stringify(sample),
        });
    }

    function logUpsertIgnoredPerMessage(upsert, reason) {
        const messages = upsert?.messages || [];
        if (messages.length === 0) {
            logInbox('baileys_upsert_ignored', {
                reason,
                upsertType: upsert?.type || null,
                count: 0,
            });
            return;
        }
        for (const msg of messages) {
            const key = msg?.key || {};
            logInbox('baileys_upsert_ignored', {
                reason,
                upsertType: upsert?.type || null,
                messageId: key.id || null,
                remoteJid: key.remoteJid || null,
                senderPn: key.senderPn || key.participantPn || null,
                fromMe: Boolean(key.fromMe),
            });
        }
    }

    function quarantineInbound(msg, reason, extra = {}) {
        inboundQuarantinedCount += 1;
        const messageId = String(msg?.key?.id || '').trim();
        const remoteJid = msg?.key?.remoteJid || null;
        const senderPn = msg?.key?.senderPn || msg?.key?.participantPn || null;
        logInbox('baileys_inbound_quarantined', {
            reason,
            messageId: messageId || null,
            remoteJid,
            senderPn,
            ...extra,
        });
        if (!messageId || !msg) return;
        inboundQuarantine.put({
            messageId,
            providerMessageId: null,
            remoteLid: String(remoteJid || '').endsWith('@lid') ? remoteJid : null,
            remoteJid,
            senderPn,
            upsertType: extra.upsertType || 'notify',
            messageTimestamp: msg.messageTimestamp || null,
            reason,
            attempts: Number(extra.attempts) || 0,
            msg,
        });
    }

    /**
     * Active LID→PN resolution using sources supported by Baileys 6.7.24:
     * - key.senderPn / participantPn
     * - persisted lidCache / contacts / chats.phoneNumberShare
     * There is NO getPNForLID on signalRepository in 6.7.24.
     * USyncLIDProtocol is PN→LID only (onWhatsApp).
     */
    function tryResolveLidNative(msg) {
        const key = msg?.key || {};
        const remoteJid = String(key.remoteJid || '').trim();
        const senderPn = String(key.senderPn || key.participantPn || '').trim();
        const tried = [];

        if (senderPn && (senderPn.endsWith('@s.whatsapp.net') || senderPn.endsWith('@c.us'))) {
            tried.push('key.senderPn');
            if (remoteJid.endsWith('@lid')) {
                lidCache.rememberPn(remoteJid, senderPn, 'active.senderPn');
            }
            return { resolved: true, pnJid: senderPn, source: 'key.senderPn', tried };
        }

        tried.push('lidCache.resolvePn');
        if (remoteJid.endsWith('@lid')) {
            const mapped = lidCache.resolvePn(remoteJid);
            if (mapped) {
                return { resolved: true, pnJid: mapped, source: 'lidCache', tried };
            }
        }

        tried.push('baileys.USyncLIDProtocol(pn_to_lid_only)');
        tried.push('signalRepository.getPNForLID(absent_in_6.7.24)');
        return { resolved: false, pnJid: null, source: null, tried };
    }

    async function captureMappedInbound(msg, mapped, upsert, waDetectedAt, captureStartedAt) {
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
            logInbox('baileys_inbound_ignored', {
                reason: 'spool_duplicate',
                providerMessageId: mapped.providerMessageId,
                messageId: msg?.key?.id || null,
            });
            return;
        }

        spool.capture(mapped.normalized, { timing });
        lastEventAt = captureCompletedAt;
        lastCapturedCount += 1;
        lastError = null;

        // Clear any pending/quarantine twin for this id.
        const mid = String(msg?.key?.id || '').trim();
        if (mid) {
            if (lidPending.has(mid)) lidPending.take(mid);
            if (decryptPending.has(mid)) decryptPending.take(mid);
            inboundQuarantine.remove(mid);
        }

        logInbox('baileys_captured', {
            providerMessageId: mapped.providerMessageId,
            phone: mapped.phone,
            captureLatencyMs: timing.captureLatencyMs,
        });

        if (typeof onLiveInbound === 'function') {
            try {
                onLiveInbound({
                    providerMessageId: mapped.providerMessageId,
                    externalContactKey: mapped.phone || mapped.normalized?.phone || null,
                    fromMe: false,
                    isGroup: Boolean(mapped.normalized?.isGroup),
                    messageTimestamp: mapped.normalized?.messageTimestamp
                        || msg.messageTimestamp
                        || null,
                    receivedAt: captureCompletedAt,
                    upsertType: upsert?.type || 'notify',
                    content: mapped.normalized?.text
                        || mapped.normalized?.content
                        || mapped.normalized
                        || null,
                    normalized: mapped.normalized,
                });
            } catch (hookErr) {
                logger.error('[baileys] onLiveInbound_failed', {
                    error: hookErr && hookErr.message ? hookErr.message : String(hookErr),
                });
            }
        }

        await worker.tick();
    }

    function enqueueUnresolvedLid(msg, upsert) {
        const messageId = String(msg?.key?.id || '').trim();
        unresolvedLidCount += 1;

        // Immediate active resolve before buffering.
        const native = tryResolveLidNative(msg);
        if (native.resolved) {
            logInbox('baileys_inbound_lid_native_resolved', {
                messageId: messageId || null,
                source: native.source,
                remoteJid: msg?.key?.remoteJid || null,
            });
            return 'retry_map';
        }

        if (!messageId) {
            quarantineInbound(msg, 'unresolved_lid_missing_id', { upsertType: upsert?.type });
            return 'quarantined';
        }

        const result = lidPending.enqueue(
            messageId,
            { msg, upsertType: upsert?.type || 'notify', reason: 'unresolved_lid' },
            {
                onTimeout: (entry) => {
                    quarantineInbound(entry.msg, 'unresolved_lid_timeout', {
                        pendingMs: lidPending.timeoutMs,
                        upsertType: entry.upsertType,
                    });
                },
                onRetry: (entry) => {
                    const again = tryResolveLidNative(entry.msg);
                    if (!again.resolved) {
                        logInbox('baileys_inbound_lid_resolve_retry', {
                            messageId,
                            tried: (again.tried || []).join(','),
                            pendingLid: lidPending.size(),
                        });
                        return;
                    }
                    logInbox('baileys_inbound_lid_native_resolved', {
                        messageId,
                        source: again.source,
                        via: 'pending_retry',
                    });
                    void reprocessPendingLidMessages();
                },
            },
        );
        if (!result.ok) {
            quarantineInbound(msg, result.reason || 'unresolved_lid_buffer_full', {
                upsertType: upsert?.type,
            });
            return 'quarantined';
        }
        if (result.duplicate) {
            logInbox('baileys_inbound_ignored', {
                reason: 'unresolved_lid_pending_duplicate',
                messageId,
                remoteJid: msg?.key?.remoteJid || null,
            });
            return 'pending';
        }
        logInbox('baileys_inbound_lid_pending', {
            messageId,
            remoteJid: msg?.key?.remoteJid || null,
            timeoutMs: lidPending.timeoutMs,
            pendingLid: lidPending.size(),
            nativeTried: (native.tried || []).join(','),
        });
        return 'pending';
    }

    function enqueueDecryptPending(msg, upsert) {
        const messageId = String(msg?.key?.id || '').trim();
        // Learn LID mapping from ciphertext envelope when senderPn is present.
        tryResolveLidNative(msg);

        if (!messageId) {
            decryptFailedCount += 1;
            quarantineInbound(msg, 'decrypt_failed_missing_id', { upsertType: upsert?.type });
            return;
        }

        const result = decryptPending.enqueue(
            messageId,
            { msg, upsertType: upsert?.type || 'notify', reason: 'decrypt_pending' },
            {
                onTimeout: (entry) => {
                    decryptFailedCount += 1;
                    quarantineInbound(entry.msg, 'decrypt_timeout', {
                        pendingMs: decryptPending.timeoutMs,
                        upsertType: entry.upsertType,
                    });
                },
                onRetry: () => {
                    logInbox('baileys_inbound_decrypt_wait', {
                        messageId,
                        pendingDecrypt: decryptPending.size(),
                    });
                },
            },
        );
        if (!result.ok) {
            decryptFailedCount += 1;
            quarantineInbound(msg, result.reason || 'decrypt_pending_buffer_full', {
                upsertType: upsert?.type,
            });
            return;
        }
        if (result.duplicate) {
            logInbox('baileys_inbound_ignored', {
                reason: 'decrypt_pending_duplicate',
                messageId,
                remoteJid: msg?.key?.remoteJid || null,
            });
            return;
        }
        logInbox('baileys_inbound_decrypt_pending', {
            messageId,
            remoteJid: msg?.key?.remoteJid || null,
            senderPn: msg?.key?.senderPn || msg?.key?.participantPn || null,
            timeoutMs: decryptPending.timeoutMs,
            pendingDecrypt: decryptPending.size(),
        });
    }

    async function reprocessPendingLidMessages() {
        const snapshot = lidPending.list();
        if (snapshot.length === 0) return;
        for (const item of snapshot) {
            tryResolveLidNative(item.msg);
            const mapped = mapBaileysInbound(item.msg, { includeGroups, seenKeys, lidCache });
            if (mapped.action !== 'capture') continue;
            const taken = lidPending.take(item.messageId);
            if (!taken) continue;
            logInbox('baileys_inbound_lid_resolved', {
                messageId: item.messageId,
                remoteJid: item.msg?.key?.remoteJid || null,
                waitMs: Date.now() - (taken.enqueuedAt || Date.now()),
            });
            await captureMappedInbound(
                item.msg,
                mapped,
                { type: item.upsertType || 'notify' },
                utcNow(),
                utcNow(),
            );
        }
    }

    async function reprocessDurableQuarantine({ reason } = {}) {
        const items = inboundQuarantine.list();
        if (items.length === 0) return;
        for (const item of items) {
            if (!item.msg) {
                inboundQuarantine.remove(item.messageId);
                continue;
            }
            // Still ciphertext? keep waiting for a later upsert with content.
            const stubType = Number(item.msg?.messageStubType);
            if (stubType === 2 || stubType === 47) continue;

            tryResolveLidNative(item.msg);
            const mapped = mapBaileysInbound(item.msg, { includeGroups, seenKeys, lidCache });
            if (mapped.action !== 'capture') {
                inboundQuarantine.bumpAttempt(item.messageId);
                continue;
            }
            inboundQuarantine.remove(item.messageId);
            logInbox('baileys_inbound_quarantine_reprocessed', {
                messageId: item.messageId,
                reason: reason || 'mapping_available',
                originalReason: item.reason,
            });
            await captureMappedInbound(
                item.msg,
                mapped,
                { type: item.upsertType || 'notify' },
                utcNow(),
                utcNow(),
            );
        }
    }

    async function handleMessagesUpsert(upsert, generation) {
        if (generation !== connectGeneration || sock === null) {
            logUpsertIgnoredPerMessage(upsert, 'stale_generation');
            return;
        }

        const gate = shouldProcessUpsert(upsert);
        if (!gate.accept) {
            logUpsertIgnoredPerMessage(upsert, gate.reason);
            return;
        }

        const waDetectedAt = utcNow();
        for (const msg of upsert.messages || []) {
            const captureStartedAt = utcNow();

            // Human/manual (and automated) fromMe outbounds → Cashier observation webhook.
            // Never crash Baileys if Cashier is down.
            if (msg?.key?.fromMe) {
                try {
                    const observed = mapBaileysOutboundObserved(msg, {
                        includeGroups,
                        lidCache,
                        seenOutboundKeys,
                    });
                    if (observed.action === 'observe') {
                        outboundPoster.observe(observed.payload).catch((err) => {
                            logInbox('outbound_observed_handler_error', {
                                providerMessageId: observed.providerMessageId,
                                error: err && err.message ? err.message : String(err),
                            });
                        });
                        logInbox('baileys_outbound_observed', {
                            providerMessageId: observed.providerMessageId,
                            phone: observed.phone,
                            remoteJid: observed.remoteJid,
                        });
                    } else if (observed.action === 'duplicate') {
                        logInbox('baileys_outbound_ignored', {
                            reason: 'duplicate',
                            providerMessageId: observed.providerMessageId,
                        });
                    } else {
                        logInbox('baileys_outbound_ignored', {
                            reason: observed.reason,
                            remoteJid: observed.remoteJid || msg?.key?.remoteJid || null,
                            messageId: msg?.key?.id || null,
                        });
                    }
                } catch (err) {
                    logInbox('outbound_observed_handler_error', {
                        messageId: msg?.key?.id || null,
                        error: err && err.message ? err.message : String(err),
                    });
                }
                continue;
            }

            // CIPHERTEXT stub = decrypt not yet available. Wait for Baileys retry upsert
            // (often type=append) instead of permanently dropping.
            const stubType = Number(msg?.messageStubType);
            if (stubType === 2 || stubType === 47) {
                enqueueDecryptPending(msg, upsert);
                continue;
            }

            // Successful content for a decrypt-pending id → clear pending and continue.
            const mid = String(msg?.key?.id || '').trim();
            if (mid && decryptPending.has(mid)) {
                decryptPending.take(mid);
                logInbox('baileys_inbound_decrypt_resolved', {
                    messageId: mid,
                    upsertType: upsert?.type || null,
                });
            }

            const lidOutcome = (() => {
                // Pre-resolve LID before mapping so mapBaileysInbound sees PN.
                const native = tryResolveLidNative(msg);
                return native;
            })();
            void lidOutcome;

            const mapped = mapBaileysInbound(msg, { includeGroups, seenKeys, lidCache });
            if (mapped.action === 'duplicate') {
                logInbox('baileys_inbound_ignored', {
                    reason: 'duplicate',
                    dedupeKey: mapped.dedupeKey,
                    remoteJid: msg?.key?.remoteJid || null,
                    messageId: msg?.key?.id || null,
                });
                continue;
            }
            if (mapped.action !== 'capture') {
                if (mapped.reason === 'unresolved_lid') {
                    const outcome = enqueueUnresolvedLid(msg, upsert);
                    if (outcome === 'retry_map') {
                        const remapped = mapBaileysInbound(msg, { includeGroups, seenKeys, lidCache });
                        if (remapped.action === 'capture') {
                            await captureMappedInbound(msg, remapped, upsert, waDetectedAt, captureStartedAt);
                        }
                    }
                    continue;
                }
                if (mapped.reason === 'empty_content') {
                    emptyContentCount += 1;
                }
                logInbox('baileys_inbound_ignored', {
                    reason: mapped.reason,
                    remoteJid: mapped.remoteJid,
                    customerJid: mapped.customerJid,
                    messageId: msg?.key?.id || null,
                    upsertType: upsert?.type || null,
                });
                continue;
            }

            // Mapping arrived; drop any pending twin for same id.
            if (mid && lidPending.has(mid)) {
                lidPending.take(mid);
            }

            await captureMappedInbound(msg, mapped, upsert, waDetectedAt, captureStartedAt);
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
                lastQr = qr;
                logger.info('[baileys] QR required — scan with Linked devices on the salon phone');
                if (printQrToTerminal) {
                    qrcode.generate(qr, { small: true });
                }
            }
            if (connection === 'open') {
                ready = true;
                qrRequired = false;
                lastQr = null;
                loggedOut = false;
                lastDisconnectCode = null;
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
                const isLoggedOut = statusCode === DisconnectReason.loggedOut
                    || statusCode === 401;
                lastDisconnectCode = statusCode != null ? statusCode : null;
                lastError = (err && err.message) || `connection_closed:${statusCode}`;
                logger.warn('[baileys] connection_closed', {
                    statusCode,
                    loggedOut: isLoggedOut,
                });

                if (isLoggedOut) {
                    loggedOut = true;
                    qrRequired = false;
                    lastQr = null;
                    clearReconnectTimer();
                    if (typeof onLoggedOut === 'function') {
                        try {
                            onLoggedOut({ statusCode, accountAuthDir: authDir });
                        } catch (_) {
                            // never break socket handling on hook failure
                        }
                    }
                }

                if (!stopping && !isLoggedOut && sock === socket) {
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

        messagesUpsertListenersTotal += 1;
        socket.ev.on('messages.upsert', (upsert) => {
            logRawUpsert(upsert, generation);
            handleMessagesUpsert(upsert, generation).catch((err) => {
                lastError = err.message || String(err);
                logger.error('[baileys] upsert_failed', { error: lastError });
                logUpsertIgnoredPerMessage(upsert, 'handler_error');
            });
        });

        messagesUpdateListenersTotal += 1;
        socket.ev.on('messages.update', (updates) => {
            try {
                handleOutboundUpdates(updates, generation);
            } catch (err) {
                logger.error('[baileys] outbound_update_failed', {
                    error: err.message || String(err),
                });
            }
        });

        messageReceiptListenersTotal += 1;
        socket.ev.on('message-receipt.update', (receipts) => {
            try {
                handleOutboundReceipts(receipts, generation);
            } catch (err) {
                logger.error('[baileys] outbound_receipt_failed', {
                    error: err.message || String(err),
                });
            }
        });

        currentSocketListenersAttached = {
            messagesUpsert: 1,
            messagesUpdate: 1,
            messageReceipt: 1,
        };

        return socket;
    }

    async function start() {
        listening = true;
        if (!loggedOut) {
            worker.start();
            await connect();
        }
        return getStatus();
    }

    async function stop() {
        stopping = true;
        listening = false;
        ready = false;
        worker.stop();
        lidPending.clear();
        decryptPending.clear();
        clearReconnectTimer();
        await teardownSocket();
        return getStatus();
    }

    async function send(phone, message) {
        if (loggedOut) {
            return {
                success: false,
                status: 'failed',
                error: 'WhatsApp session is logged out. Re-pair required.',
                code: 'LOGGED_OUT',
                sendAttempted: false,
                outcomeUnknown: false,
            };
        }
        if (!sock || !ready) {
            return {
                success: false,
                status: 'failed',
                error: 'WhatsApp transport is not ready. Please scan the QR code and try again.',
                sendAttempted: false,
                outcomeUnknown: false,
            };
        }

        const destination = resolveOutboundJid(phone, lidCache);
        if (!destination.ok) {
            return {
                success: false,
                status: 'failed',
                error: destination.error || 'invalid_phone',
                sendAttempted: false,
                outcomeUnknown: false,
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
            if (!messageId) {
                return {
                    success: false,
                    status: 'unknown',
                    code: 'OUTBOUND_RESULT_UNKNOWN',
                    error: 'Baileys send returned without providerMessageId',
                    phone: destination.phone,
                    chatId: jid,
                    route: destination.route,
                    sendAttempted: true,
                    outcomeUnknown: true,
                    sendLatencyMs: sendCompletedAt - sendStartedAt,
                };
            }
            return {
                success: true,
                status: 'sent',
                messageId,
                phone: destination.phone,
                chatId: jid,
                route: destination.route,
                sendLatencyMs: sendCompletedAt - sendStartedAt,
                sendAttempted: true,
                outcomeUnknown: false,
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
                status: 'unknown',
                code: 'OUTBOUND_RESULT_UNKNOWN',
                error: lastError,
                phone: destination.phone,
                chatId: jid,
                route: destination.route,
                sendAttempted: true,
                outcomeUnknown: true,
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
        getQr,
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
