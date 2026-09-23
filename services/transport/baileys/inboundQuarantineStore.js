'use strict';

/**
 * Durable inbound quarantine for messages that need LID/decrypt recovery.
 * Survives process restart; reprocessed when mapping/decrypt becomes available.
 * Never stores auth/crypto secrets.
 */

const fs = require('fs');
const path = require('path');

function createInboundQuarantineStore({
  filePath,
  maxEntries = Number(process.env.BAILEYS_INBOUND_QUARANTINE_MAX || 200),
  retentionMs = Number(process.env.BAILEYS_INBOUND_QUARANTINE_RETENTION_MS || 7 * 24 * 60 * 60 * 1000),
  now = () => Date.now(),
} = {}) {
  if (!filePath) throw new Error('inbound quarantine filePath required');
  const byId = new Map();

  function ensureDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function load() {
    ensureDir();
    if (!fs.existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      byId.clear();
      const cutoff = now() - retentionMs;
      for (const [id, entry] of Object.entries(parsed.byId || {})) {
        if (!entry || !entry.messageId) continue;
        const created = Date.parse(entry.createdAt || '') || 0;
        if (created && created < cutoff) continue;
        byId.set(id, entry);
      }
    } catch (_) {
      // keep empty on corrupt
    }
  }

  function persist() {
    ensureDir();
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      byId: Object.fromEntries(byId.entries()),
    };
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  function size() {
    return byId.size;
  }

  function get(messageId) {
    return byId.get(String(messageId || '').trim()) || null;
  }

  function list() {
    return Array.from(byId.values());
  }

  function listByRemoteLid(remoteLid) {
    const lid = String(remoteLid || '').trim();
    if (!lid) return [];
    return list().filter((e) => String(e.remoteLid || '') === lid);
  }

  function put(entry) {
    const messageId = String(entry?.messageId || '').trim();
    if (!messageId) return { ok: false, reason: 'missing_message_id' };
    if (byId.has(messageId)) {
      return { ok: true, duplicate: true, entry: byId.get(messageId) };
    }
    if (byId.size >= maxEntries) {
      // drop oldest
      const oldest = list().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (oldest) byId.delete(oldest.messageId);
    }
    const record = {
      messageId,
      providerMessageId: entry.providerMessageId || null,
      remoteLid: entry.remoteLid || null,
      remoteJid: entry.remoteJid || null,
      senderPn: entry.senderPn || null,
      upsertType: entry.upsertType || 'notify',
      messageTimestamp: entry.messageTimestamp || null,
      reason: entry.reason || 'unknown',
      attempts: Number(entry.attempts) || 0,
      createdAt: entry.createdAt || new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      // Minimal payload needed to re-run mapBaileysInbound (same shape as WAMessage).
      msg: entry.msg || null,
    };
    byId.set(messageId, record);
    persist();
    return { ok: true, duplicate: false, entry: record };
  }

  function remove(messageId) {
    const id = String(messageId || '').trim();
    const existed = byId.delete(id);
    if (existed) persist();
    return existed;
  }

  function bumpAttempt(messageId) {
    const entry = get(messageId);
    if (!entry) return null;
    entry.attempts = (Number(entry.attempts) || 0) + 1;
    entry.updatedAt = new Date(now()).toISOString();
    byId.set(entry.messageId, entry);
    persist();
    return entry;
  }

  load();

  return {
    filePath,
    size,
    get,
    list,
    listByRemoteLid,
    put,
    remove,
    bumpAttempt,
    load,
    persist,
  };
}

module.exports = {
  createInboundQuarantineStore,
};
