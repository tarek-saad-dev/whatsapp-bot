'use strict';

/**
 * Safe diagnostic logger for Baileys v7 worker.
 * Never logs message text, full JIDs, phones, or auth/keys.
 */

const REDACT_KEYS = new Set([
  'text',
  'conversation',
  'content',
  'body',
  'message',
  'auth',
  'creds',
  'keys',
  'session',
  'signal',
  'private',
  'payload',
  'raw',
]);

/**
 * @param {unknown} value
 * @returns {'PN'|'LID'|'GROUP'|'OTHER'}
 */
export function classifyRemote(value) {
  const s = String(value || '');
  if (s.includes('@g.us')) return 'GROUP';
  if (s.includes('@lid')) return 'LID';
  if (s.includes('@s.whatsapp.net') || s.includes('@c.us')) return 'PN';
  return 'OTHER';
}

/**
 * @param {import('@whiskeysockets/baileys').WAMessage | Record<string, unknown>} msg
 */
export function summarizeInbound(msg) {
  const key = (msg && msg.key) || {};
  const message = (msg && msg.message) || null;
  const stubType = msg && msg.messageStubType != null ? Number(msg.messageStubType) : null;
  const remoteJid = key.remoteJid || null;
  const remoteType = classifyRemote(remoteJid);
  const senderPnPresent = Boolean(key.senderPn || key.participantAlt || msg.senderPn);
  const fromMe = Boolean(key.fromMe);

  let contentType = null;
  let plaintextPresent = false;
  let textLength = 0;
  if (message && typeof message === 'object') {
    const keys = Object.keys(message).filter((k) => k !== 'messageContextInfo');
    contentType = keys[0] || null;
    const conv = message.conversation;
    const ext = message.extendedTextMessage && message.extendedTextMessage.text;
    if (typeof conv === 'string') {
      plaintextPresent = true;
      textLength = conv.length;
    } else if (typeof ext === 'string') {
      plaintextPresent = true;
      textLength = ext.length;
    }
  }

  let decryptOutcome = 'unknown';
  if (fromMe) decryptOutcome = 'ignored_fromMe';
  else if (remoteType === 'GROUP') decryptOutcome = 'ignored_group';
  else if (stubType === 2 || (contentType === null && stubType != null)) {
    decryptOutcome = plaintextPresent ? 'plaintext_with_stub' : 'ciphertext_or_stub';
  } else if (plaintextPresent) decryptOutcome = 'plaintext_ok';
  else if (!message) decryptOutcome = 'no_message_node';
  else decryptOutcome = 'no_plaintext';

  return {
    timestamp: new Date().toISOString(),
    messageId: key.id || null,
    upsertType: null,
    remoteType,
    senderPnPresent: senderPnPresent ? 'YES' : 'NO',
    stubType,
    contentType,
    plaintextPresent: plaintextPresent ? 'YES' : 'NO',
    textLength,
    decryptOutcome,
    fromMe,
  };
}

export function assertSafeLogShape(obj) {
  const json = JSON.stringify(obj);
  for (const bad of ['@s.whatsapp.net', '@lid', '@c.us', '@g.us']) {
    if (json.includes(bad)) {
      throw new Error(`unsafe log leaked jid marker: ${bad}`);
    }
  }
  for (const k of Object.keys(obj)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      throw new Error(`unsafe log key: ${k}`);
    }
  }
  return true;
}

export function logInboundSafe(summary, upsertType) {
  const line = {
    ...summary,
    upsertType: upsertType || summary.upsertType,
  };
  // eslint-disable-next-line no-console
  console.log('[v7-worker-inbound]', JSON.stringify(line));
  return line;
}
