'use strict';

import { isLidUser, isPnUser, jidNormalizedUser } from '@whiskeysockets/baileys';

/**
 * Normalize a fromMe Baileys message into a safe outbound observation.
 * Never returns raw Baileys objects.
 */

function digitsFromJid(jid) {
  const s = String(jid || '');
  const m = /^(\d{8,15})@(?:s\.whatsapp\.net|c\.us)$/i.exec(s);
  return m ? m[1] : null;
}

function extractPlainText(msg) {
  const message = msg?.message;
  if (!message || typeof message !== 'object') return null;
  if (typeof message.conversation === 'string') return message.conversation;
  if (message.extendedTextMessage && typeof message.extendedTextMessage.text === 'string') {
    return message.extendedTextMessage.text;
  }
  if (message.imageMessage && typeof message.imageMessage.caption === 'string') {
    return message.imageMessage.caption;
  }
  if (message.videoMessage && typeof message.videoMessage.caption === 'string') {
    return message.videoMessage.caption;
  }
  return null;
}

function hasMedia(msg) {
  const message = msg?.message;
  if (!message || typeof message !== 'object') return false;
  return Boolean(
    message.imageMessage
    || message.videoMessage
    || message.audioMessage
    || message.documentMessage
    || message.stickerMessage,
  );
}

function isProtocolOrSystem(msg) {
  const message = msg?.message;
  if (!message || typeof message !== 'object') return true;
  const keys = Object.keys(message).filter((k) => k !== 'messageContextInfo');
  if (!keys.length) return true;
  const t = keys[0];
  return t === 'protocolMessage'
    || t === 'senderKeyDistributionMessage'
    || t === 'reactionMessage'
    || t === 'encReactionMessage'
    || t === 'pollUpdateMessage'
    || t === 'keepInChatMessage';
}

/**
 * Destination customer JID for fromMe — never the business own identity.
 */
async function resolveDestinationJid(msg, { resolveLidPn = null, ownDigits = null } = {}) {
  const key = msg?.key || {};
  const remote = String(key.remoteJid || '');
  const candidates = [
    key.remoteJidAlt,
    key.participantAlt,
    // For fromMe, prefer destination PN alts over senderPn (sender may be self).
    remote,
  ];

  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    if (isLidUser(c)) continue;
    const normalized = (() => {
      try {
        return jidNormalizedUser(c) || c;
      } catch {
        return c;
      }
    })();
    if (isPnUser(c) || /@(?:s\.whatsapp\.net|c\.us)$/i.test(c)) {
      const digits = digitsFromJid(normalized);
      if (!digits) continue;
      if (ownDigits && digits === ownDigits) {
        return { reject: 'self_destination' };
      }
      return `${digits}@s.whatsapp.net`;
    }
  }

  if (isLidUser(remote) && typeof resolveLidPn === 'function') {
    try {
      const pn = await resolveLidPn(remote);
      if (pn) {
        const digits = digitsFromJid(jidNormalizedUser(pn) || pn) || String(pn).replace(/\D/g, '');
        if (/^\d{8,15}$/.test(digits)) {
          if (ownDigits && digits === ownDigits) {
            return { reject: 'self_destination' };
          }
          return `${digits}@s.whatsapp.net`;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

/**
 * @returns {Promise<
 *   | { ok: true, observation: object }
 *   | { ok: false, reason: string }
 * >}
 */
export async function buildV7OutboundObservation(msg, {
  resolveLidPn = null,
  ownDigits = null,
} = {}) {
  const key = msg?.key || {};
  if (!key.fromMe) return { ok: false, reason: 'not_fromMe' };

  const remote = String(key.remoteJid || '');
  if (remote.endsWith('@g.us')) return { ok: false, reason: 'group' };
  if (remote === 'status@broadcast' || remote.endsWith('@broadcast')) {
    return { ok: false, reason: 'status_or_broadcast' };
  }

  if (isProtocolOrSystem(msg)) return { ok: false, reason: 'protocol_or_system' };

  const text = extractPlainText(msg);
  const media = hasMedia(msg);
  if (!text && !media) return { ok: false, reason: 'empty_content' };

  const messageId = String(key.id || '').trim();
  if (!messageId) return { ok: false, reason: 'missing_message_id' };

  const customerJid = await resolveDestinationJid(msg, { resolveLidPn, ownDigits });
  if (customerJid && typeof customerJid === 'object' && customerJid.reject) {
    return { ok: false, reason: customerJid.reject };
  }
  if (!customerJid || typeof customerJid !== 'string') {
    return { ok: false, reason: 'unresolved_destination' };
  }

  const phone = digitsFromJid(customerJid);
  if (!phone) return { ok: false, reason: 'missing_phone' };
  if (ownDigits && phone === ownDigits) {
    return { ok: false, reason: 'self_destination' };
  }

  const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
  const occurredAt = new Date((ts > 1e12 ? ts : ts * 1000)).toISOString();

  return {
    ok: true,
    observation: {
      providerMessageId: messageId,
      phone,
      text: text || null,
      occurredAt,
    },
  };
}
