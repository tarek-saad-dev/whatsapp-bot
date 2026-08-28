'use strict';

const TYPING_PREVIEW_RE = /^(يكتب(\.\.\.)?|typing(\.\.\.)?|recording(\.\.\.)?|جار[ٍي]?(?:ٍ)?(?: الكتابة| التسجيل)?(\.\.\.)?)$/i;

function arabicIndicToAscii(value) {
    return String(value || '').replace(/[٠-٩]/g, (digit) => {
        const index = '٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
        return index >= 0 ? String(index) : digit;
    });
}

function isUnreadLabel(label) {
    const text = String(label || '').trim();
    if (!text) return false;
    return /unread/i.test(text) || /غير مقروء/.test(text);
}

function parseUnreadCount(ariaLabels) {
    const labels = Array.isArray(ariaLabels) ? ariaLabels : [ariaLabels];
    for (const label of labels) {
        if (!isUnreadLabel(label)) continue;
        const ascii = arabicIndicToAscii(label);
        const match = ascii.match(/(\d+)/);
        if (match) {
            const count = Number(match[1]);
            return Number.isFinite(count) && count > 0 ? count : 1;
        }
        return 1;
    }
    return 0;
}

function summarizeUnreadChats(rows) {
    const seenTitles = new Set();
    const chats = [];
    for (const row of rows || []) {
        const title = String(row && row.title ? row.title : '').trim();
        if (!title || seenTitles.has(title)) continue;
        const unreadCount = parseUnreadCount(row.ariaLabels);
        if (unreadCount <= 0) continue;
        seenTitles.add(title);
        chats.push({ title, unreadCount });
    }
    return chats;
}

function parseRemoteFromDataId(messageId) {
    const raw = String(messageId || '').replace(/^(true|false)_/, '');
    const remote = raw.split('_')[0] || '';
    return remote.includes('@') ? remote : '';
}

function isFromMeMessage(message) {
    const id = String(message && message.id ? message.id : '');
    const className = String(message && message.className ? message.className : '');
    if (id.startsWith('true_') || /\bmessage-out\b/.test(className)) return true;
    if (id.startsWith('false_') || /\bmessage-in\b/.test(className)) return false;
    return Boolean(message && message.fromMe);
}

function normalizeIncomingMessage(message, chatTitle) {
    const id = String(message && message.id ? message.id : '').trim();
    if (!id || isFromMeMessage(message)) return null;

    const chatId = parseRemoteFromDataId(id);
    const isGroup = chatId.endsWith('@g.us');
    const phone = chatId.endsWith('@c.us') ? chatId.split('@')[0] : null;
    const text = String(message && message.text ? message.text : '').trim();

    return {
        messageId: id,
        chatTitle: chatTitle || '',
        chatId: chatId || null,
        phone,
        isGroup,
        text: text || (message && message.hasMedia ? '[media]' : ''),
        receivedAt: new Date().toISOString(),
    };
}

function ingestChatMessages({
    chatTitle,
    messages,
    unreadCount = 0,
    seenIds,
    seededChats,
}) {
    const incoming = (messages || [])
        .map((message) => normalizeIncomingMessage(message, chatTitle))
        .filter(Boolean);

    const fresh = [];
    if (!seededChats.has(chatTitle)) {
        seededChats.add(chatTitle);
        const toReport = unreadCount > 0 ? incoming.slice(-unreadCount) : [];
        const reportIds = new Set(toReport.map((message) => message.messageId));
        for (const message of incoming) {
            seenIds.add(message.messageId);
            if (reportIds.has(message.messageId)) fresh.push(message);
        }
        return fresh;
    }

    for (const message of incoming) {
        if (seenIds.has(message.messageId)) continue;
        seenIds.add(message.messageId);
        fresh.push(message);
    }
    return fresh;
}

function phoneFromChatTitle(chatTitle) {
    const raw = String(chatTitle || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) {
        return digits;
    }
    return null;
}

function isTypingPreview(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return true;
    if (TYPING_PREVIEW_RE.test(normalized)) return true;
    if (/^(يكتب|typing|recording)/i.test(normalized) && /\.{2,}$/.test(normalized)) return true;
    return false;
}

function previewMessageId(chatTitle, previewText, triggeredAt) {
    const key = `${chatTitle}\0${previewText}\0${triggeredAt || ''}`;
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
        hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return `preview-${Math.abs(hash).toString(36)}`;
}

function normalizePreviewEvent(event) {
    const chatTitle = String(event && event.chatTitle ? event.chatTitle : '').trim();
    const previewText = String(event && event.previewText ? event.previewText : '').trim();
    const triggeredAt = event && event.triggeredAt
        ? event.triggeredAt
        : new Date().toISOString();
    if (!chatTitle || !previewText || isTypingPreview(previewText)) return null;

    const phone = phoneFromChatTitle(chatTitle);
    return {
        messageId: previewMessageId(chatTitle, previewText, triggeredAt),
        chatTitle,
        chatId: phone ? `${phone}@c.us` : null,
        phone,
        isGroup: false,
        text: previewText,
        unreadCount: Number(event.unreadCount) || 1,
        source: 'chat_list_trigger',
        receivedAt: triggeredAt,
    };
}

function ingestPreviewEvents(events, seenIds, recentByChat) {
    const fresh = [];
    const now = Date.now();
    const dedupeWindowMs = 4000;

    for (const event of events || []) {
        const normalized = normalizePreviewEvent(event);
        if (!normalized) continue;

        const recent = recentByChat.get(normalized.chatTitle);
        if (
            recent
            && recent.text === normalized.text
            && (now - recent.at) < dedupeWindowMs
        ) {
            continue;
        }

        if (seenIds.has(normalized.messageId)) continue;

        seenIds.add(normalized.messageId);
        recentByChat.set(normalized.chatTitle, { text: normalized.text, at: now });
        fresh.push(normalized);
    }
    return fresh;
}

function createInboxStore({ maxMessages = 200 } = {}) {
    const seenIds = new Set();
    const seededChats = new Set();
    const recentByChat = new Map();
    const messages = [];

    function pushMessages(nextMessages) {
        for (const message of nextMessages || []) {
            messages.push(message);
        }
        if (messages.length > maxMessages) {
            messages.splice(0, messages.length - maxMessages);
        }
        return nextMessages || [];
    }

    function ingest({ chatTitle, messages: chatMessages, unreadCount = 0 }) {
        return pushMessages(ingestChatMessages({
            chatTitle,
            messages: chatMessages,
            unreadCount,
            seenIds,
            seededChats,
        }));
    }

    function list(limit = 50) {
        const size = Math.max(0, Number(limit) || 50);
        return messages.slice(-size);
    }

    function snapshot() {
        return {
            count: messages.length,
            seenCount: seenIds.size,
            seededChats: seededChats.size,
            messages: list(maxMessages),
        };
    }

    function ingestPreview(events) {
        return pushMessages(ingestPreviewEvents(events, seenIds, recentByChat));
    }

    function reset() {
        seenIds.clear();
        seededChats.clear();
        recentByChat.clear();
        messages.length = 0;
    }

    return { ingest, ingestPreview, list, snapshot, reset, seenIds, seededChats };
}

module.exports = {
    arabicIndicToAscii,
    isUnreadLabel,
    parseUnreadCount,
    summarizeUnreadChats,
    parseRemoteFromDataId,
    isFromMeMessage,
    normalizeIncomingMessage,
    ingestChatMessages,
    phoneFromChatTitle,
    isTypingPreview,
    previewMessageId,
    normalizePreviewEvent,
    ingestPreviewEvents,
    createInboxStore,
};
