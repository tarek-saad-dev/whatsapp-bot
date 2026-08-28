'use strict';

const crypto = require('crypto');
const {
    phoneFromChatTitle,
    resolveMessageDirection,
    isPresenceOrStatusText,
    pickContactTitle,
} = require('./inboxLogic');

const PROVIDER = 'whatsapp-web';

const ID_SOURCE = {
    NATIVE: 'native',
    FINGERPRINT_STABLE: 'fingerprint_stable',
    FINGERPRINT_DEGRADED: 'fingerprint_degraded',
};

function parseDataId(dataId) {
    const raw = String(dataId || '').trim();
    if (!raw) return null;
    const fromMe = raw.startsWith('true_');
    const incoming = raw.startsWith('false_');
    const body = raw.replace(/^(true|false)_/, '');
    const remoteJid = body.split('_')[0] || '';
    const messageKey = body.slice(remoteJid.length + 1) || '';
    return { raw, fromMe, incoming, remoteJid, messageKey };
}

function isNativeProviderMessageId(value) {
    const parsed = parseDataId(value);
    return Boolean(parsed && parsed.incoming && parsed.remoteJid && parsed.messageKey);
}

function extractMessageTimestamp(prePlainText) {
    const text = String(prePlainText || '').trim();
    if (!text) return null;
    const bracketMatch = text.match(/^\[([^\]]+)\]/);
    if (bracketMatch) return bracketMatch[1].trim();
    return null;
}

function inferRemoteJid(rawMessage, chatTitle, parsed) {
    if (parsed && parsed.remoteJid) return parsed.remoteJid;
    const phone = phoneFromChatTitle(chatTitle);
    if (phone) return `${phone}@c.us`;
    return null;
}

function hashCanonical(canonical) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(canonical))
        .digest('hex')
        .slice(0, 32);
}

function buildFingerprint(rawMessage, chatTitle) {
    const parsed = parseDataId(rawMessage.id);
    const remoteJid = inferRemoteJid(rawMessage, chatTitle, parsed);
    const messageTimestamp = extractMessageTimestamp(rawMessage.prePlainText)
        || rawMessage.messageTimestamp
        || null;
    const waMessageKey = parsed && parsed.messageKey ? parsed.messageKey : null;

    const stableCanonical = {
        provider: PROVIDER,
        remoteJid,
        direction: 'inbound',
        messageTimestamp,
        messageType: rawMessage.hasMedia ? 'media' : 'text',
        text: String(rawMessage.text || '').trim(),
        waMessageKey,
    };

    const hasStableDiscriminator = Boolean(messageTimestamp || waMessageKey);

    if (hasStableDiscriminator) {
        return {
            providerMessageId: `fp-${hashCanonical(stableCanonical)}`,
            idSource: ID_SOURCE.FINGERPRINT_STABLE,
        };
    }

    const degradedCanonical = {
        ...stableCanonical,
        chatTitle: String(chatTitle || '').trim(),
        domIndex: Number.isFinite(rawMessage.domIndex) ? rawMessage.domIndex : null,
    };

    return {
        providerMessageId: `fp-${hashCanonical(degradedCanonical)}`,
        idSource: ID_SOURCE.FINGERPRINT_DEGRADED,
    };
}

function resolveProviderMessageId(rawMessage, chatTitle) {
    const direction = resolveMessageDirection(rawMessage);
    if (direction === 'outbound') return null;

    const nativeId = String(rawMessage.id || '').trim();
    if (isNativeProviderMessageId(nativeId)) {
        return { providerMessageId: nativeId, idSource: ID_SOURCE.NATIVE };
    }
    if (direction === 'unknown') return null;
    return buildFingerprint(rawMessage, chatTitle);
}

function validateNormalizedEvent(event) {
    const errors = [];
    if (!event || typeof event !== 'object') {
        return { valid: false, errors: ['INVALID_EVENT'] };
    }
    if (!event.provider) errors.push('MISSING_PROVIDER');
    if (!event.providerMessageId) errors.push('MISSING_PROVIDER_MESSAGE_ID');
    if (!event.receivedAt) errors.push('MISSING_RECEIVED_AT');
    if (!event.messageType) errors.push('MISSING_MESSAGE_TYPE');
    if (event.direction !== 'inbound') errors.push('NOT_INBOUND');
    if (!event.isGroup && !event.phone) errors.push('MISSING_PHONE');
    if (isPresenceOrStatusText(event.chatTitle)) errors.push('INVALID_CHAT_TITLE');
    return { valid: errors.length === 0, errors };
}

function normalizeMessage(rawMessage, chatTitle, { includeGroups = false, remoteJid: contextRemoteJid = null } = {}) {
    const direction = resolveMessageDirection(rawMessage);
    if (direction === 'outbound') return null;
    if (direction === 'unknown') return null;

    const parsed = parseDataId(rawMessage.id);
    const resolved = resolveProviderMessageId(rawMessage, chatTitle);
    if (!resolved) return null;
    const { providerMessageId, idSource } = resolved;

    const remoteJid = (parsed && parsed.remoteJid)
        || contextRemoteJid
        || inferRemoteJid(rawMessage, chatTitle, parsed)
        || '';
    const isGroup = remoteJid.endsWith('@g.us');
    if (isGroup && !includeGroups) return null;

    const phone = remoteJid.endsWith('@c.us')
        ? remoteJid.split('@')[0]
        : phoneFromChatTitle(chatTitle);

    const text = String(rawMessage.text || '').trim();
    const messageType = rawMessage.hasMedia && !text ? 'media' : 'text';

    if (!text && messageType !== 'media') return null;

    const messageTimestamp = extractMessageTimestamp(rawMessage.prePlainText);
    const resolvedTitle = pickContactTitle(chatTitle, phone);

    const event = {
        provider: PROVIDER,
        providerMessageId,
        idSource,
        direction: 'inbound',
        remoteJid: remoteJid || null,
        phone: phone || null,
        chatTitle: resolvedTitle || phone || '',
        messageType,
        text: text || '[media]',
        isGroup,
        receivedAt: new Date().toISOString(),
        rawPayload: {
            dataId: rawMessage.id || null,
            className: rawMessage.className || null,
            prePlainText: rawMessage.prePlainText || null,
            messageTimestamp,
            hasMedia: Boolean(rawMessage.hasMedia),
            waMessageKey: parsed && parsed.messageKey ? parsed.messageKey : null,
            direction: 'inbound',
        },
    };

    const validation = validateNormalizedEvent(event);
    if (!validation.valid) return null;

    return event;
}

module.exports = {
    PROVIDER,
    ID_SOURCE,
    parseDataId,
    isNativeProviderMessageId,
    extractMessageTimestamp,
    buildFingerprint,
    resolveProviderMessageId,
    validateNormalizedEvent,
    normalizeMessage,
};
