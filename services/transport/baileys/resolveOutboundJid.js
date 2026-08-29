'use strict';

/**
 * Resolve outbound destination JID.
 * Prefer a known persisted @lid mapping when available; otherwise PN @s.whatsapp.net.
 * Never infers/fabricates LID values from digits.
 */

function normalizePhoneDigits(phone) {
    return String(phone || '').replace(/\D/g, '');
}

function resolveOutboundJid(phone, lidCache = null) {
    const digits = normalizePhoneDigits(phone);
    if (!digits) {
        return { ok: false, error: 'invalid_phone' };
    }

    const pnJid = `${digits}@s.whatsapp.net`;
    let lidJid = null;
    if (lidCache && typeof lidCache.resolveLidByPhone === 'function') {
        lidJid = lidCache.resolveLidByPhone(digits);
    }

    if (lidJid && String(lidJid).endsWith('@lid')) {
        return {
            ok: true,
            jid: String(lidJid),
            route: 'lid',
            phone: digits,
            pnJid,
            lidJid: String(lidJid),
        };
    }

    return {
        ok: true,
        jid: pnJid,
        route: 'pn',
        phone: digits,
        pnJid,
        lidJid: null,
    };
}

module.exports = {
    resolveOutboundJid,
    normalizePhoneDigits,
};
