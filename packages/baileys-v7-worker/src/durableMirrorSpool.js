'use strict';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only crash-replay queue for thousands of historical events.
 * Unlike a JSON-array spool, capture is O(1) instead of rewriting history.
 * No raw Baileys objects or auth keys are logged here.
 */
export function createDurableMirrorSpool({ journalFile, compactAfterBytes = 24 * 1024 * 1024 }) {
  fs.mkdirSync(path.dirname(journalFile), { recursive: true, mode: 0o700 });
  const records = new Map();
  let writes = 0;

  function apply(op) {
    if (op.kind === 'capture' && !records.has(op.id)) {
      records.set(op.id, {
        providerMessageId: op.id, normalizedEvent: op.event,
        status: 'pending_delivery', attempts: 0, nextRetryAt: op.at,
        capturedAt: op.at, deliveredAt: null,
      });
    } else if (op.kind === 'state') {
      const row = records.get(op.id);
      if (!row) return;
      row.status = op.status;
      row.attempts = op.attempts ?? row.attempts;
      row.nextRetryAt = op.nextRetryAt ?? row.nextRetryAt;
      row.deliveredAt = op.deliveredAt ?? row.deliveredAt;
    }
  }

  if (fs.existsSync(journalFile)) {
    for (const line of fs.readFileSync(journalFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { apply(JSON.parse(line)); } catch { /* ignore torn final record */ }
    }
  }

  function compactIfNeeded() {
    if (writes < 1000) return;
    let size;
    try { size = fs.statSync(journalFile).size; } catch { return; }
    if (size < compactAfterBytes) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const ops = [];
    for (const row of records.values()) {
      if (row.status === 'delivered' && Date.parse(row.deliveredAt || '') < cutoff) {
        records.delete(row.providerMessageId);
        continue;
      }
      ops.push(JSON.stringify({ kind: 'capture', id: row.providerMessageId,
        event: row.normalizedEvent, at: row.capturedAt }));
      if (row.status !== 'pending_delivery' || row.attempts > 0)
        ops.push(JSON.stringify({ kind: 'state', id: row.providerMessageId,
          status: row.status, attempts: row.attempts, nextRetryAt: row.nextRetryAt,
          deliveredAt: row.deliveredAt }));
    }
    const tmp = journalFile + '.compacting';
    fs.writeFileSync(tmp, ops.join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, journalFile);
    writes = 0;
  }

  function append(op) {
    fs.appendFileSync(journalFile, JSON.stringify(op) + '\n', { mode: 0o600 });
    apply(op);
    writes++;
    compactIfNeeded();
  }

  return {
    capture(event) {
      const id = event?.providerMessageId;
      if (!id) throw new Error('missing providerMessageId');
      if (records.has(id)) return records.get(id);
      append({ kind: 'capture', id, event, at: new Date().toISOString() });
      return records.get(id);
    },
    hasProviderMessageId(id) { return records.has(id); },
    getPendingForDelivery(now = new Date()) {
      return [...records.values()]
        .filter(row => row.status === 'pending_delivery'
          && Date.parse(row.nextRetryAt) <= now.getTime())
        .sort((a,b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    },
    markDelivered(id) {
      const row = records.get(id);
      if (!row) return null;
      append({ kind: 'state', id, status: 'delivered',
        deliveredAt: new Date().toISOString() });
      return records.get(id);
    },
    markRetry(id, { nextRetryAt, error } = {}) {
      const row = records.get(id);
      if (!row) return null;
      append({ kind: 'state', id, status: 'pending_delivery',
        attempts: row.attempts + 1, nextRetryAt: nextRetryAt || new Date().toISOString() });
      // Error details are intentionally not saved with customer content.
      void error;
      return records.get(id);
    },
    getStats() {
      const all = [...records.values()];
      return { total: all.length,
        pending: all.filter(x=>x.status==='pending_delivery').length,
        delivered: all.filter(x=>x.status==='delivered').length,
        failed: all.filter(x=>x.status==='failed').length };
    },
  };
}
