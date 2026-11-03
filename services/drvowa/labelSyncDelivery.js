'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { writeAtomicFile } = require('./atomicWrite');
const { getDrvowaSaasBaseUrl } = require('./s2sAuth');

function createLabelSyncDelivery({
  accountKey, authDir, fetchImpl = global.fetch, logger = console,
} = {}) {
  if (!accountKey || !authDir) throw new Error('Label sync requires accountKey and authDir');
  const spoolFile = path.join(authDir, 'labels-sync.json');
  const records = new Map();
  let timer = null;
  let busy = false;
  let delivered = 0;
  let errors = 0;

  function save() {
    fs.mkdirSync(path.dirname(spoolFile), { recursive: true, mode: 0o700 });
    writeAtomicFile(spoolFile, JSON.stringify({ version: 1, records: [...records.values()] }) + '\n');
  }
  if (fs.existsSync(spoolFile)) {
    // Corruption must be diagnosed rather than silently replacing unsent events.
    const contents = JSON.parse(fs.readFileSync(spoolFile, 'utf8'));
    for (const row of contents.records || []) if (row.id) records.set(row.id, row);
  }
  function capture(event) {
    if (!event || !['label', 'labelAssociation'].includes(event.kind)) return false;
    const id = randomUUID();
    records.set(id, { id, event, at: Date.now(), nextAt: 0, attempts: 0 });
    save(); // durable BEFORE first network attempt
    void flush();
    return true;
  }
  async function flush() {
    if (busy || typeof fetchImpl !== 'function' || !process.env.DRVOWA_RUNTIME_TOKEN) return;
    busy = true;
    try {
      const due = [...records.values()].filter(x => x.nextAt <= Date.now())
        .sort((a,b) => a.at - b.at).slice(0, 12);
      if (!due.length) return;
      const response = await fetchImpl(getDrvowaSaasBaseUrl() + '/api/runtime/whatsapp/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.DRVOWA_RUNTIME_TOKEN,
        },
        body: JSON.stringify({ accountKey, events: due.map(x => x.event) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('LABEL_HTTP_' + response.status);
      for (const row of due) records.delete(row.id);
      delivered += due.length;
      save();
    } catch (error) {
      errors++;
      for (const row of records.values()) {
        if (row.nextAt > Date.now()) continue;
        row.attempts += 1;
        row.nextAt = Date.now() + Math.min(120000, 2000 * (2 ** Math.min(row.attempts, 6)));
      }
      save();
      logger.warn?.('[drvowa-label-sync] retry_next_tick', { code: String(error?.name || 'SYNC_ERROR') });
    } finally { busy = false; }
  }
  return {
    capture,
    start() {
      if (!timer) timer = setInterval(() => void flush(), 5000);
      void flush();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    getStatus() {
      return {
        coverage: 'EVENT_DRIVEN_PARTIAL', pending: records.size,
        delivered, errors, running: Boolean(timer), audienceReady: false,
      };
    },
    flush,
  };
}
module.exports = { createLabelSyncDelivery };
