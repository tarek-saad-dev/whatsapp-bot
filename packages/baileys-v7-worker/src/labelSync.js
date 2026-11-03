'use strict';

/**
 * Read-only normalization of WhatsApp Business label events.
 * Groups, message labels, newsletters and unresolved LIDs are NOT audiences.
 */
function phoneJid(value) {
  const m = /^(\d{8,15})@(?:s\.whatsapp\.net|c\.us)$/i.exec(String(value || ''));
  return m ? m[1] + '@s.whatsapp.net' : null;
}

export function normalizeLabelEdit(label) {
  const id = String(label?.id ?? '').trim();
  if (!id || id.length > 128) return null;
  const name = typeof label?.name === 'string' ? label.name.trim().slice(0, 200) : null;
  return {
    kind: 'label',
    labelId: id,
    ...(name ? { name } : {}),
    ...(Number.isInteger(label?.color) && label.color >= 0
      && label.color <= 1000000 ? { color: label.color } : {}),
    deleted: Boolean(label?.deleted),
  };
}

export async function normalizeLabelAssociation(payload, { resolveLidPn } = {}) {
  const association = payload?.association || null;
  if (!association || association.type !== 'label_jid') return null;
  const labelId = String(association.labelId ?? '').trim();
  if (!labelId || labelId.length > 128) return null;
  const raw = String(association.chatId || '').trim();
  let jid = phoneJid(raw);
  if (!jid && raw.endsWith('@lid') && typeof resolveLidPn === 'function') {
    try { jid = phoneJid(await resolveLidPn(raw)); } catch { /* unresolved */ }
  }
  if (!jid) return null;
  if (payload.type !== 'add' && payload.type !== 'remove') return null;
  return {
    kind: 'labelAssociation',
    labelId,
    contactKey: jid,
    action: payload.type,
  };
}
