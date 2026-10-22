'use strict';

import { buildProviderMessageId, resolveExternalContactKey } from './dto.js';
import { buildV7OutboundObservation } from './outboundObserve.js';

const MEDIA_MAP = [
  ['imageMessage', 'IMAGE'], ['audioMessage', 'AUDIO'],
  ['videoMessage', 'VIDEO'], ['documentMessage', 'DOCUMENT'],
  ['stickerMessage', 'STICKER'],
];

function isoTimestamp(ts) {
  const raw = Number(ts?.toNumber?.() ?? ts ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return new Date().toISOString();
  const d = new Date(raw > 1e12 ? raw : raw * 1000);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function digitsJid(value) {
  const m = /^(\d{8,15})@(?:s\.whatsapp\.net|c\.us)$/i.exec(String(value || ''));
  return m ? m[1] : null;
}

async function resolveContact(msg, { resolveLidPn, ownDigits } = {}) {
  if (msg?.key?.fromMe) {
    const outbound = await buildV7OutboundObservation(msg, { resolveLidPn, ownDigits });
    return outbound.ok ? `${outbound.observation.phone}@s.whatsapp.net` : null;
  }
  const direct = resolveExternalContactKey(msg);
  if (direct) return direct;
  const lid = String(msg?.key?.remoteJid || '');
  if (!lid.endsWith('@lid') || !resolveLidPn) return null;
  try {
    const mapped = await resolveLidPn(lid);
    const digits = digitsJid(mapped);
    return digits ? `${digits}@s.whatsapp.net` : null;
  } catch { return null; }
}

export async function normalizeMirrorMessage(msg, {
  resolveLidPn = null, ownDigits = null, historical = false,
} = {}) {
  const key = msg?.key || {};
  const remote = String(key.remoteJid || '');
  if (!key.id || remote.endsWith('@g.us') || remote.includes('@broadcast')
      || Boolean(msg?.broadcast)
      || String(key.remoteJidAlt || '').endsWith('@g.us')
      || String(key.remoteJidAlt || '').endsWith('@broadcast')
      || remote.endsWith('@newsletter')
      || remote.endsWith('@call')) return null;
  const contactKey = await resolveContact(msg, { resolveLidPn, ownDigits });
  if (!contactKey) return null;
  const content = msg?.message || {};
  const mediaEntry = MEDIA_MAP.find(([k]) => content[k]);
  const media = mediaEntry ? content[mediaEntry[0]] : null;
  const plain = content.conversation ?? content.extendedTextMessage?.text
    ?? content.imageMessage?.caption ?? content.videoMessage?.caption
    ?? content.documentMessage?.caption ?? null;
  if (!media && (typeof plain !== 'string' || plain.trim().length === 0)) return null;
  const context = content.extendedTextMessage?.contextInfo
    ?? media?.contextInfo ?? null;
  const fileLength = Number(media?.fileLength?.toNumber?.() ?? media?.fileLength ?? 0);
  const providerMessageId = key.fromMe
    ? String(key.id)
    : buildProviderMessageId(contactKey, String(key.id));
  if (!providerMessageId) return null;
  return {
    kind: 'message',
    contactKey,
    providerMessageId,
    direction: key.fromMe ? 'OUTBOUND' : 'INBOUND',
    historical: Boolean(historical),
    occurredAt: isoTimestamp(msg.messageTimestamp),
    contentType: mediaEntry ? mediaEntry[1] : 'TEXT',
    text: typeof plain === 'string' ? plain.slice(0, 8000) : null,
    mimeType: media?.mimetype ? String(media.mimetype).slice(0, 128) : null,
    fileName: media?.fileName ? String(media.fileName).slice(0, 256) : null,
    fileSize: Number.isSafeInteger(fileLength) && fileLength >= 0 ? fileLength : null,
    quotedProviderMessageId: context?.stanzaId
      ? String(context.stanzaId).slice(0, 256) : null,
  };
}

export async function normalizeMirrorChat(chat, { resolveLidPn = null } = {}) {
  const id = String(chat?.id || chat?.jid || '');
  let digits = digitsJid(id);
  if (!digits && id.endsWith('@lid') && resolveLidPn) {
    try { digits = digitsJid(await resolveLidPn(id)); } catch { /* skip unresolved */ }
  }
  if (!digits) return null;
  const archiveValue = chat.archived;
  const pinnedValue = chat.pinned ?? chat.pin;
  return {
    kind: 'chat',
    contactKey: `${digits}@s.whatsapp.net`,
    displayName: typeof (chat.name ?? chat.notify ?? chat.verifiedName) === 'string'
      ? String(chat.name ?? chat.notify ?? chat.verifiedName).slice(0, 200) : null,
    lastMessageAt: chat.conversationTimestamp
      ? isoTimestamp(chat.conversationTimestamp) : null,
    ...(typeof archiveValue === 'boolean' ? { archived: archiveValue } : {}),
    ...(pinnedValue != null ? { pinned: Boolean(pinnedValue) } : {}),
  };
}
