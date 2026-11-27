// Diagnostic only. One instance per account/worker; no automatic sends or auth changes.
// WhatsApp WebMessageInfo.Status: DELIVERY_ACK=3, READ=4, PLAYED=5.
const deliveredStatuses = new Set([3, 4, 5]);
function jid(value) {
  const m = /^([0-9]+)(?::[0-9]+)?@(s\.whatsapp\.net|lid)$/.exec(String(value || ''));
  return m ? m[1] + '@' + m[2] : null;
}
export function createDeliveryEvidence({ now = Date.now, maxEntries = 512, ttlMs = 30 * 60_000 } = {}) {
  let connected = false, inboundAt = null, deliveredAt = null;
  let pending = new Map();
  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    pending.clear();
    inboundAt = deliveredAt = null;
  }
  function sweep() {
    const cutoff = now();
    for (const [id, entry] of pending) if (entry.expiresAt <= cutoff) pending.delete(id);
  }
  function recordInbound(key, type, plaintext) {
    if (!connected || type !== 'notify' || !plaintext || key?.fromMe !== false || !key?.id || !jid(key.remoteJid)) return false;
    inboundAt = new Date(now()).toISOString();
    return true;
  }
  function recordSent(key, originalJid) {
    if (!connected || key?.fromMe !== true || !key.id || !jid(key.remoteJid) || !jid(originalJid)) return false;
    sweep();
    const addresses = new Set([jid(key.remoteJid), jid(key.remoteJidAlt), jid(originalJid)].filter(Boolean));
    const id = String(key.id);
    if (pending.has(id)) return false;
    pending.set(id, { addresses, expiresAt: now() + ttlMs });
    while (pending.size > maxEntries) pending.delete(pending.keys().next().value);
    return true;
  }
  function recordUpdate(key, status) {
    if (!connected || key?.fromMe !== true || !deliveredStatuses.has(status)) return false;
    sweep();
    const id = String(key.id || '');
    const entry = pending.get(id);
    if (!entry || !entry.addresses.has(jid(key.remoteJid))) return false;
    pending.delete(id);
    deliveredAt = new Date(now()).toISOString();
    return true;
  }
  function snapshot() {
    sweep();
    return { status: !connected ? 'NOT_CONNECTED' : inboundAt && deliveredAt ? 'BOTH_OBSERVED' : inboundAt ? 'INBOUND_OBSERVED' : deliveredAt ? 'OUTBOUND_DELIVERY_OBSERVED' : 'UNVERIFIED',
      lastLivePlaintextAt: inboundAt, lastOutboundDeliveryAckAt: deliveredAt, pendingReceiptCount: pending.size };
  }
  return { setConnected, recordInbound, recordSent, recordUpdate, snapshot };
}
