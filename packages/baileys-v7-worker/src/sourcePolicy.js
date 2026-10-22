'use strict';

/**
 * Only the original conversation JID can distinguish a group/status/broadcast
 * from the phone identity of the author. Never use senderPn or participantPn.
 */
export function blockedSourceReason(msg) {
  if (msg?.broadcast === true) return 'broadcast';
  for (const value of [msg?.key?.remoteJid, msg?.key?.remoteJidAlt]) {
    const jid = String(value || '').trim().toLowerCase();
    if (jid.endsWith('@g.us')) return 'group';
    if (jid.endsWith('@broadcast')) return 'broadcast';
    if (jid.endsWith('@newsletter')) return 'newsletter';
    if (jid.endsWith('@call')) return 'call';
  }
  if (!String(msg?.key?.remoteJid || '').trim()) return 'missing_remote_jid';
  return null;
}
