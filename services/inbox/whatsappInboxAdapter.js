'use strict';

const { By } = require('selenium-webdriver');
const {
    summarizeUnreadChats,
    isFromMeMessage,
    resolveMessageDirection,
    pickContactTitle,
    parseRemoteFromDataId,
} = require('./inboxLogic');
const { normalizeMessage, ID_SOURCE } = require('./normalizeMessage');
const { logInbox } = require('./inboxLogger');
const { utcNow, isoBetween } = require('./inboxTiming');
const {
    scrapeChatRows,
    scrapeOpenConversation,
    drainInboxEvents,
    drainOpenChatEvents,
    getInboxTriggerStatus,
} = require('./pageScripts');

const DEFAULT_MAX_CHATS = Number(process.env.WHATSAPP_INBOX_MAX_CHATS_PER_POLL || 5);

async function clickChatRowNative(drv, title) {
    if (!title || !drv || !drv.findElement) return false;
    try {
        const el = await drv.findElement(
            By.xpath(`//div[@id='pane-side']//span[@title=${JSON.stringify(String(title))}]`),
        );
        await el.click();
        return true;
    } catch (_) {
        return false;
    }
}

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

    function captureNormalized(rawMessage, chatTitle, remoteJid, normalizedEvents, seenThisPoll) {
        if (isFromMeMessage(rawMessage)) return;
        if (resolveMessageDirection(rawMessage) !== 'inbound') return;

        const normalized = normalizeMessage(rawMessage, chatTitle, {
            includeGroups,
            remoteJid,
        });
        if (!normalized) return;
        if (seenThisPoll.has(normalized.providerMessageId)) return;
        if (hasProviderMessageId(normalized.providerMessageId)) return;

        seenThisPoll.add(normalized.providerMessageId);
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

    async function processOpenChatEvents(drv, normalizedEvents, seenThisPoll) {
        const drained = await drv.executeScript(drainOpenChatEvents);
        const events = (drained && drained.events) || [];
        for (const event of events) {
            const chatTitle = pickContactTitle(event.chatTitle);
            const rawMessage = event.message;
            if (!rawMessage) continue;
            const remoteJid = rawMessage.id
                ? parseRemoteFromDataId(rawMessage.id)
                : null;
            captureNormalized(rawMessage, chatTitle, remoteJid, normalizedEvents, seenThisPoll);
        }
        return events.length;
    }

    async function processTriggerEvents(drv, normalizedEvents, seenThisPoll) {
        const drained = await drv.executeScript(drainInboxEvents);
        const events = (drained && drained.events) || [];
        if (events.length === 0) return 0;

        for (const event of events) {
            if (!event || event.type !== 'incoming_preview') continue;
            const chatTitle = pickContactTitle(event.chatTitle);
            if (!chatTitle) continue;

            const clicked = await clickChatRowNative(drv, chatTitle);
            if (!clicked) continue;
            if (sleep) await sleep(600);

            const opened = await drv.executeScript(scrapeOpenConversation);
            const resolvedTitle = pickContactTitle(chatTitle, opened && opened.chatTitle);
            const remoteJid = (opened && opened.remoteJid) || null;
            const messages = selectIncomingMessages(
                (opened && opened.messages) || [],
                event.unreadCount || 1,
            );

            for (const rawMessage of messages) {
                captureNormalized(rawMessage, resolvedTitle, remoteJid, normalizedEvents, seenThisPoll);
            }
        }
        return events.length;
    }

    async function processUnreadChats(drv, normalizedEvents, seenThisPoll) {
        const rows = await drv.executeScript(scrapeChatRows);
        const unreadChats = summarizeUnreadChats(rows).slice(0, maxChatsPerPoll);

        for (const chat of unreadChats) {
            const clicked = await clickChatRowNative(drv, chat.title);
            if (!clicked) continue;
            if (sleep) await sleep(600);

            const opened = await drv.executeScript(scrapeOpenConversation);
            const chatTitle = pickContactTitle(chat.title, opened && opened.chatTitle);
            const remoteJid = (opened && opened.remoteJid) || null;
            const messages = selectIncomingMessages(
                (opened && opened.messages) || [],
                chat.unreadCount,
            );

            for (const rawMessage of messages) {
                captureNormalized(rawMessage, chatTitle, remoteJid, normalizedEvents, seenThisPoll);
            }
        }
        return unreadChats.length;
    }

    async function extractUnreadMessages(ctx = {}) {
        const drv = getDriver && getDriver();
        if (!drv) return [];

        const captureStartedAt = ctx.captureStartedAt || utcNow();
        const waDetectedAt = ctx.waDetectedAt || captureStartedAt;

        if (switchToWhatsAppTab) {
            await switchToWhatsAppTab();
        }

        const normalizedEvents = [];
        const seenThisPoll = new Set();

        await processOpenChatEvents(drv, normalizedEvents, seenThisPoll);
        await processTriggerEvents(drv, normalizedEvents, seenThisPoll);
        await processUnreadChats(drv, normalizedEvents, seenThisPoll);

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
    clickChatRowNative,
};
