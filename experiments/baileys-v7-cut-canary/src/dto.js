'use strict';

import { isLidUser, isPnUser, jidNormalizedUser } from '@whiskeysockets/baileys';

/**
 * Build DRVOWA inbound DTO from a decrypted Baileys v7 message.
 * Never includes raw Baileys objects.
 */

function digitsFromJid(jid) {
  const s = String(jid || '');
  const m = /^(\d{8,15})@(?:s\.whatsapp\.net|c\.us)$/i.exec(s);
  return m ? m[1] : null;
}

/**
 * Resolve a phone-bearing contact key for SaaS.
 * Prefers PN alt fields introduced in Baileys v7.
 */
export function resolveExternalContactKey(msg) {
  const key = msg?.key || {};
  const candidates = [
    key.remoteJidAlt,
    key.senderPn,
    key.participantPn,
    key.participantAlt,
    key.remoteJid,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    if (isLidUser(c)) continue;
    if (isPnUser(c) || /@(?:s\.whatsapp\.net|c\.us)$/i.test(c)) {
      const digits = digitsFromJid(jidNormalizedUser(c) || c);
      if (digits) return `${digits}@s.whatsapp.net`;
    }
    const bare = String(c).replace(/\D/g, '');
    if (/^\d{8,15}$/.test(bare)) return `${bare}@s.whatsapp.net`;
  }
  return null;
}

export function extractPlainText(msg) {
  const message = msg?.message;
  if (!message || typeof message !== 'object') return null;
  if (typeof message.conversation === 'string') return message.conversation;
  if (message.extendedTextMessage && typeof message.extendedTextMessage.text === 'string') {
    return message.extendedTextMessage.text;
  }
  return null;
}

export function buildProviderMessageId(externalContactKey, messageId) {
  const digits = digitsFromJid(externalContactKey) || String(externalContactKey || '').replace(/\D/g, '');
  if (!digits || !messageId) return null;
  // Match production v6 providerMessageId shape used by Cut Salon history
  return `false_${digits}@c.us_${messageId}`;
}

/**
 * @returns {Promise<{ ok: true, dto: object, meta: object } | { ok: false, reason: string }>}
 */
export async function buildCanaryInboundDto(msg, {
  accountKey,
  upsertType = 'notify',
  resolveLidPn = null,
} = {}) {
  if (!accountKey) return { ok: false, reason: 'missing_account_key' };
  const key = msg?.key || {};
  if (key.fromMe) return { ok: false, reason: 'fromMe' };
  const remote = String(key.remoteJid || '');
  if (remote.endsWith('@g.us') || remote === 'status@broadcast') {
    return { ok: false, reason: 'group_or_status' };
  }
  const text = extractPlainText(msg);
  if (!text || !String(text).trim()) return { ok: false, reason: 'no_plaintext' };

  let externalContactKey = resolveExternalContactKey(msg);
  if (!externalContactKey && typeof resolveLidPn === 'function' && isLidUser(remote)) {
    try {
      const pn = await resolveLidPn(remote);
      if (pn) {
        const digits = digitsFromJid(jidNormalizedUser(pn) || pn) || String(pn).replace(/\D/g, '');
        if (/^\d{8,15}$/.test(digits)) {
          externalContactKey = `${digits}@s.whatsapp.net`;
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (!externalContactKey) return { ok: false, reason: 'unresolved_contact' };

  const messageId = String(key.id || '').trim();
  const providerMessageId = buildProviderMessageId(externalContactKey, messageId);
  if (!providerMessageId) return { ok: false, reason: 'missing_provider_message_id' };

  const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
  const receivedAt = new Date((ts > 1e12 ? ts : ts * 1000)).toISOString();

  return {
    ok: true,
    dto: {
      accountKey,
      provider: 'baileys',
      providerMessageId,
      externalContactKey,
      fromMe: false,
      isGroup: false,
      messageTimestamp: ts,
      receivedAt,
      upsertType: 'notify',
      content: String(text),
    },
    meta: {
      sourceUpsertType: upsertType,
      messageId,
      textLength: String(text).length,
    },
  };
}
