'use strict';

const { normalizeMessageContent, getContentType } = require('@whiskeysockets/baileys');
const { isLidUser } = require('@whiskeysockets/baileys/lib/WABinary/jid-utils');

const LIVE_UPSERT_TYPE = 'notify';

const BLOCKED_JID_SUFFIXES = [
    '@broadcast',
    '@newsletter',
    '@call',
];

function isLiveUpsertType(type) {
    return String(type || '') === LIVE_UPSERT_TYPE;
}

function isBlockedRemoteJid(remoteJid) {
    const raw = String(remoteJid || '').trim();
    if (!raw) return true;
    if (raw === 'status@broadcast') return true;
    for (const suffix of BLOCKED_JID_SUFFIXES) {
        if (raw.endsWith(suffix)) return true;
    }
    if (raw.endsWith('@lid')) return true;
    return false;
}

function isGroupJid(remoteJid) {
    return String(remoteJid || '').endsWith('@g.us');
}

function createLidPhoneCache(store = null) {
    const lidToPn = store || null;
    const memory = new Map();

    function rememberPn(lidJid, pnJid, source = 'event') {
        const lid = String(lidJid || '').trim();
        const pn = String(pnJid || '').trim();
        if (!lid.endsWith('@lid')) return false;
        if (!pn.endsWith('@s.whatsapp.net') && !pn.endsWith('@c.us')) return false;
        if (lidToPn) return lidToPn.remember(lid, pn, source);
        memory.set(lid, pn);
        return true;
    }

    function rememberContact(contact, source = 'contacts.upsert') {
        if (!contact) return;
        if (contact.lid && contact.jid) rememberPn(contact.lid, contact.jid, source);
        if (contact.id && contact.id.endsWith('@lid') && contact.jid) {
            rememberPn(contact.id, contact.jid, source);
        }
        if (contact.id && contact.jid && !contact.id.endsWith('@lid') && contact.lid) {
            rememberPn(contact.lid, contact.jid, source);
        }
    }

    function rememberChat(chat, source = 'chats.upsert') {
        if (!chat) return;
        if (chat.lidJid && chat.pnJid) rememberPn(chat.lidJid, chat.pnJid, source);
        if (chat.id && String(chat.id).endsWith('@lid') && chat.pnJid) {
            rememberPn(chat.id, chat.pnJid, source);
        }
    }

    function resolvePn(lidJid) {
        const lid = String(lidJid || '').trim();
        if (lidToPn) return lidToPn.resolvePn(lid);
        return memory.get(lid) || null;
    }

    function size() {
        if (lidToPn) return lidToPn.size();
        return memory.size;
    }

    function list() {
        if (lidToPn) return lidToPn.list();
        return Array.from(memory.entries()).map(([lid, pnJid]) => ({ lid, pnJid }));
    }

    return {
        rememberPn,
        rememberContact,
        rememberChat,
        resolvePn,
        size,
        list,
    };
}

function resolveCustomerJid(key, lidCache = null) {
    const remoteJid = String(key?.remoteJid || '').trim();
    const senderPn = String(key?.senderPn || key?.participantPn || '').trim();
    if (senderPn && (senderPn.endsWith('@s.whatsapp.net') || senderPn.endsWith('@c.us'))) {
        return senderPn;
    }
    if (isLidUser(remoteJid) && lidCache) {
        const mapped = lidCache.resolvePn(remoteJid);
        if (mapped) return mapped;
    }
    return remoteJid;
}

function isAllowedRemoteJid(remoteJid, { includeGroups = false } = {}) {
    if (isBlockedRemoteJid(remoteJid)) return false;
    if (isGroupJid(remoteJid) && !includeGroups) return false;
    if (isLidUser(remoteJid)) return false;
    return true;
}

function jidToLegacy(remoteJid) {
    const raw = String(remoteJid || '').trim();
    if (!raw) return '';
    if (raw.endsWith('@c.us')) return raw;
    if (raw.endsWith('@s.whatsapp.net')) {
        return `${raw.split('@')[0]}@c.us`;
    }
    return raw;
}

function phoneFromJid(remoteJid) {
    const legacy = jidToLegacy(remoteJid);
    if (!legacy.endsWith('@c.us')) return null;
    const digits = legacy.split('@')[0];
    return /^\d{8,15}$/.test(digits) ? digits : null;
}

function unwrapMessageContent(message) {
    return normalizeMessageContent(message || undefined) || null;
}

function isProtocolOrSystemMessage(content) {
    if (!content) return true;
    const contentType = getContentType(content);
    if (!contentType) return true;
    if (contentType === 'protocolMessage') return true;
    if (contentType === 'senderKeyDistributionMessage') return true;
    if (contentType === 'reactionMessage') return true;
    if (contentType === 'encReactionMessage') return true;
    if (contentType === 'pollUpdateMessage') return true;
    if (contentType === 'keepInChatMessage') return true;
    return false;
}

function extractText(content) {
    const message = unwrapMessageContent(content);
    if (!message || isProtocolOrSystemMessage(message)) return '';
    if (message.conversation) return String(message.conversation);
    if (message.extendedTextMessage && message.extendedTextMessage.text) {
        return String(message.extendedTextMessage.text);
    }
    if (message.imageMessage && message.imageMessage.caption) {
        return String(message.imageMessage.caption);
    }
    if (message.videoMessage && message.videoMessage.caption) {
        return String(message.videoMessage.caption);
    }
    if (message.documentMessage && message.documentMessage.caption) {
        return String(message.documentMessage.caption);
    }
    return '';
}

function hasMedia(content) {
    const message = unwrapMessageContent(content);
    if (!message || isProtocolOrSystemMessage(message)) return false;
    return Boolean(
        message.imageMessage
        || message.videoMessage
        || message.audioMessage
        || message.documentMessage
        || message.stickerMessage,
    );
}

function buildDedupeKey(remoteJid, messageId) {
    const legacyJid = jidToLegacy(remoteJid);
    return `${legacyJid}|${messageId}`;
}

function shouldProcessUpsert(upsert) {
    if (!isLiveUpsertType(upsert && upsert.type)) {
        return { accept: false, reason: 'not_live_notify' };
    }
    return { accept: true };
}

function mapBaileysInbound(msg, {
    includeGroups = false,
    seenKeys = null,
    lidCache = null,
    chatTitle = null,
    normalize = require('../../inbox/normalizeMessage').normalizeMessage,
} = {}) {
    const key = msg.key || {};
    if (key.fromMe) {
        return { action: 'ignore', reason: 'fromMe' };
    }

    const remoteJid = String(key.remoteJid || '');
    const customerJid = resolveCustomerJid(key, lidCache);
    if (isLidUser(remoteJid) && lidCache) {
        const senderPn = String(key.senderPn || key.participantPn || '').trim();
        if (senderPn && customerJid === senderPn) {
            lidCache.rememberPn(remoteJid, senderPn, 'message.senderPn');
        }
    }
    if (!isAllowedRemoteJid(customerJid, { includeGroups })) {
        return {
            action: 'ignore',
            reason: isLidUser(customerJid) || isLidUser(remoteJid) ? 'unresolved_lid' : 'blocked_jid',
            remoteJid,
            customerJid,
        };
    }

    const messageId = String(key.id || '').trim();
    if (!messageId) {
        return { action: 'ignore', reason: 'missing_message_id' };
    }

    const legacyJid = jidToLegacy(customerJid);
    const dedupeKey = buildDedupeKey(customerJid, messageId);
    if (seenKeys && seenKeys.has(dedupeKey)) {
        return { action: 'duplicate', dedupeKey };
    }

    const unwrapped = unwrapMessageContent(msg.message);
    if (isProtocolOrSystemMessage(unwrapped)) {
        return { action: 'ignore', reason: 'protocol_or_system' };
    }

    const text = extractText(msg.message);
    const media = hasMedia(msg.message);
    if (!text && !media) {
        return { action: 'ignore', reason: 'empty_content' };
    }

    const phone = phoneFromJid(customerJid);
    const resolvedTitle = chatTitle || phone || customerJid;
    const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
    const receivedIso = new Date(ts * 1000).toISOString();

    const rawMessage = {
        id: `false_${legacyJid}_${messageId}`,
        text,
        direction: 'inbound',
        hasMedia: media,
        messageTimestamp: receivedIso,
        waMessageKey: messageId,
    };

    const normalized = normalize(rawMessage, resolvedTitle, {
        includeGroups,
        remoteJid: legacyJid,
    });
    if (!normalized) {
        return { action: 'ignore', reason: 'normalize_rejected' };
    }

    normalized.receivedAt = receivedIso;
    normalized.rawPayload = {
        ...normalized.rawPayload,
        baileysKey: key,
        transport: 'baileys',
        messageTimestamp: receivedIso,
        upsertType: LIVE_UPSERT_TYPE,
        sourceRemoteJid: remoteJid,
        resolvedCustomerJid: customerJid,
    };

    if (seenKeys) seenKeys.add(dedupeKey);

    return {
        action: 'capture',
        dedupeKey,
        phone,
        remoteJid: legacyJid,
        providerMessageId: normalized.providerMessageId,
        text: normalized.text,
        timestamp: receivedIso,
        direction: 'inbound',
        normalized,
    };
}

module.exports = {
    LIVE_UPSERT_TYPE,
    isLiveUpsertType,
    isBlockedRemoteJid,
    isGroupJid,
    isAllowedRemoteJid,
    createLidPhoneCache,
    resolveCustomerJid,
    jidToLegacy,
    phoneFromJid,
    unwrapMessageContent,
    isProtocolOrSystemMessage,
    extractText,
    hasMedia,
    buildDedupeKey,
    shouldProcessUpsert,
    mapBaileysInbound,
};
