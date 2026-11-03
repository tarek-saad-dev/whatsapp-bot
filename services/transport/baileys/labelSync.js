'use strict';

function normalizeLabelEdit(label) {
  const labelId = String(label?.id ?? '').trim();
  if (!labelId || labelId.length > 128) return null;
  const name = typeof label?.name === 'string' ? label.name.trim().slice(0, 200) : null;
  return {
    kind: 'label', labelId,
    ...(name ? { name } : {}),
    ...(Number.isInteger(label?.color) && label.color >= 0 && label.color <= 1000000
      ? { color: label.color } : {}),
    deleted: Boolean(label?.deleted),
  };
}

function normalizeLabelAssociation(payload, resolveLidPn = () => null) {
  const assoc = payload?.association;
  if (!assoc || assoc.type !== 'label_jid') return null;
  const labelId = String(assoc.labelId ?? '').trim();
  if (!labelId || labelId.length > 128 || !['add', 'remove'].includes(payload.type)) return null;
  let raw = String(assoc.chatId || '').trim();
  if (raw.endsWith('@lid')) raw = String(resolveLidPn(raw) || '');
  const match = /^(\d{8,15})@(?:s\.whatsapp\.net|c\.us)$/i.exec(raw);
  if (!match) return null;
  return {
    kind: 'labelAssociation', labelId,
    contactKey: match[1] + '@s.whatsapp.net', action: payload.type,
  };
}

module.exports = { normalizeLabelEdit, normalizeLabelAssociation };
