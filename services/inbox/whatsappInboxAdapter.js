'use strict';

const {
    summarizeUnreadChats,
    isFromMeMessage,
    resolveMessageDirection,
    pickContactTitle,
} = require('./inboxLogic');
const { normalizeMessage, ID_SOURCE } = require('./normalizeMessage');
const { logInbox } = require('./inboxLogger');
const { utcNow, isoBetween } = require('./inboxTiming');
const {
    scrapeChatRows,
    clickChatRowByTitle,
    scrapeOpenConversation,
    getInboxTriggerStatus,
} = require('./pageScripts');

const DEFAULT_MAX_CHATS = Number(process.env.WHATSAPP_INBOX_MAX_CHATS_PER_POLL || 5);

function selectIncomingMessages(messages, unreadCount) {
    const inbound = (messages || []).filter((message) => {
        if (isFromMeMessage(message)) return false;
        return resolveMessageDirection(message) === 'inbound';
    });
    if (inbound.length === 0) return [];
    const limit = Math.max(Number(unreadCount) || 0, 1);
    return inbound.slice(-limit);
}

function createWhatsAppInboxAdapter({
    getDriver,
    switchToWhatsAppTab,
    sleep,
    includeGroups = process.env.WHATSAPP_INBOX_INCLUDE_GROUPS === 'true',
    maxChatsPerPoll = DEFAULT_MAX_CHATS,
    hasProviderMessageId = () => false,
} = {}) {
    let lastPollAt = null;
    let lastError = null;
    let lastExtractCount = 0;
    let lastBrowserQueueWaitMs = 0;
    let lastBrowserOperationMs = 0;

    async function getHealth() {
        const drv = getDriver && getDriver();
        if (!drv) {
            return { ready: false, reason: 'driver_unavailable' };
        }
        try {
            const triggerStatus = await drv.executeScript(getInboxTriggerStatus);
            return {
                ready: true,
                triggerInstalled: Boolean(triggerStatus && triggerStatus.installed),
                trackedChats: Number(triggerStatus && triggerStatus.trackedChats) || 0,
            };
        } catch (error) {
            return { ready: false, reason: error.message || String(error) };
        }
    }

    async function extractUnreadMessages(ctx = {}) {
        const drv = getDriver && getDriver();
        if (!drv) return [];

        const captureStartedAt = ctx.captureStartedAt || utcNow();
        const waDetectedAt = ctx.waDetectedAt || captureStartedAt;

        if (switchToWhatsAppTab) {
            await switchToWhatsAppTab();
        }

        const rows = await drv.executeScript(scrapeChatRows);
        const unreadChats = summarizeUnreadChats(rows).slice(0, maxChatsPerPoll);
        const normalizedEvents = [];

        for (const chat of unreadChats) {
            const clicked = await drv.executeScript(clickChatRowByTitle, chat.title);
            if (!clicked) continue;
            if (sleep) await sleep(900);

            const opened = await drv.executeScript(scrapeOpenConversation);
            const chatTitle = pickContactTitle(chat.title, opened && opened.chatTitle);
            const remoteJid = (opened && opened.remoteJid) || null;
            const messages = selectIncomingMessages(
                (opened && opened.messages) || [],
                chat.unreadCount,
            );

            for (const rawMessage of messages) {
                if (isFromMeMessage(rawMessage)) continue;
                if (resolveMessageDirection(rawMessage) !== 'inbound') continue;

                const normalized = normalizeMessage(rawMessage, chatTitle, {
                    includeGroups,
                    remoteJid,
                });
                if (!normalized) continue;
                if (hasProviderMessageId(normalized.providerMessageId)) continue;

                normalizedEvents.push(normalized);
                if (normalized.idSource === ID_SOURCE.FINGERPRINT_DEGRADED) {
                    logInbox('degraded_message_id', {
                        providerMessageId: normalized.providerMessageId,
                        idSource: normalized.idSource,
                        chatTitle: normalized.chatTitle,
                        reason: 'no_stable_timestamp_or_wa_message_key',
                    });
                }
                logInbox('message_captured', {
                    providerMessageId: normalized.providerMessageId,
                    idSource: normalized.idSource,
                    direction: normalized.direction,
                    chatTitle: normalized.chatTitle,
                    phone: normalized.phone || undefined,
                    text: normalized.text,
                });
            }
        }

        const captureCompletedAt = utcNow();
        const captureLatencyMs = isoBetween(captureStartedAt, captureCompletedAt);
        const timing = {
            waDetectedAt,
            captureStartedAt,
            captureCompletedAt,
            captureLatencyMs,
            browserQueueWaitMs: ctx.browserQueueWaitMs ?? lastBrowserQueueWaitMs,
            browserOperationMs: ctx.browserOperationMs ?? lastBrowserOperationMs,
        };

        lastExtractCount = normalizedEvents.length;
        lastPollAt = captureCompletedAt;
        lastError = null;

        return normalizedEvents.map((event) => ({ event, timing: { ...timing } }));
    }

    async function poll(ctx = {}) {
        try {
            const bundles = await extractUnreadMessages(ctx);
            return bundles;
        } catch (error) {
            lastError = error.message || String(error);
            logInbox('adapter_poll_failed', { error: lastError });
            throw error;
        }
    }

    return {
        poll,
        extractUnreadMessages,
        normalizeMessage,
        selectIncomingMessages,
        getHealth,
        setBrowserTiming({ browserQueueWaitMs = 0, browserOperationMs = 0 } = {}) {
            lastBrowserQueueWaitMs = browserQueueWaitMs;
            lastBrowserOperationMs = browserOperationMs;
        },
        getStatus() {
            return {
                lastPollAt,
                lastError,
                lastExtractCount,
                includeGroups,
                maxChatsPerPoll,
                browserQueueWaitMs: lastBrowserQueueWaitMs,
                browserOperationMs: lastBrowserOperationMs,
            };
        },
    };
}

module.exports = {
    createWhatsAppInboxAdapter,
    selectIncomingMessages,
};
