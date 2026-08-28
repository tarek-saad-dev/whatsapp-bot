'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { performance } = require('perf_hooks');
const { createInboxSpool } = require('../services/inbox/inboxSpool');
const { createInboxDeliveryWorker } = require('../services/inbox/inboxDeliveryWorker');
const { createSendQueue } = require('../services/sendQueue');
const { normalizeMessage } = require('../services/inbox/normalizeMessage');
const { utcNow, isoBetween } = require('../services/inbox/inboxTiming');

const SAMPLE_COUNT = Number(process.env.SMOKE_LATENCY_SAMPLES || 8);
const PORT = Number(process.env.SMOKE_MOCK_CASHIER_PORT || 4011);
const TOKEN = process.env.WHATSAPP_INBOX_WEBHOOK_TOKEN || 'test-token';

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function summarize(name, values) {
  if (!values.length) return { name, samples: [] };
  const summary = {
    name,
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
  };
  if (values.length >= 3) summary.p50 = percentile(values, 50);
  if (values.length >= 5) summary.p95 = percentile(values, 95);
  if (!summary.p50) summary.samples = values;
  return summary;
}

function startMockCashier() {
  const seen = new Set();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
          return;
        }

        let payload;
        try {
          payload = JSON.parse(body);
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
          return;
        }

        const duplicate = seen.has(payload.providerMessageId);
        if (!duplicate) seen.add(payload.providerMessageId);

        res.writeHead(duplicate ? 200 : 201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, duplicate }));
      });
    });

    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function simulateInboundCapture(sendQueue, spool, index) {
  const waDetectedAt = utcNow();
  const captureStartedAt = utcNow();

  const runCapture = async () => {
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 15 + (index % 3) * 5));
    const event = normalizeMessage({
      id: '',
      text: `latency-smoke-${index}-${Date.now()}`,
      prePlainText: `[10:${30 + index} AM, 8/28/2026] Ahmed: latency-smoke-${index}`,
      className: 'message-in',
    }, 'Ahmed');
    const captureCompletedAt = utcNow();
    return {
      event,
      timing: {
        waDetectedAt,
        captureStartedAt,
        captureCompletedAt,
        captureLatencyMs: isoBetween(captureStartedAt, captureCompletedAt),
      },
    };
  };

  const enqueuedAt = performance.now();
  const bundle = await sendQueue.enqueue(runCapture);
  const queueTiming = sendQueue.getTimingStats();

  bundle.timing.browserQueueWaitMs = queueTiming.browserQueueWaitMs;
  bundle.timing.browserOperationMs = queueTiming.browserOperationMs;

  const writeStart = performance.now();
  spool.capture(bundle.event, { timing: bundle.timing });
  bundle.timing.spoolPersistedAt = utcNow();
  bundle.timing.spoolWriteMs = Math.round(performance.now() - writeStart);

  return {
    bundle,
    enqueueWaitMs: Math.round(performance.now() - enqueuedAt),
  };
}

async function main() {
  const server = await startMockCashier();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-phase1-latency-'));
  const spoolFile = path.join(tempDir, 'spool.json');
  const spool = createInboxSpool({ spoolFile });
  const sendQueue = createSendQueue();
  const worker = createInboxDeliveryWorker({
    spool,
    webhookUrl: `http://127.0.0.1:${PORT}/api/internal/messaging/inbox/whatsapp`,
    webhookToken: TOKEN,
  });

  const detectionToCapture = [];
  const captureToSpool = [];
  const webhookLatency = [];
  const totalDelivery = [];
  const browserQueueWait = [];
  const browserOperation = [];

  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const { bundle } = await simulateInboundCapture(sendQueue, spool, i);
    const record = spool.getPendingForDelivery()[0];
    await worker.processRecord(record);

    const delivered = spool.getRecord(record.providerMessageId);
    const timing = (delivered && delivered.timing) || bundle.timing;

    detectionToCapture.push(timing.captureLatencyMs || 0);
    captureToSpool.push(timing.spoolWriteMs || 0);
    webhookLatency.push(isoBetween(timing.webhookStartedAt, timing.webhookCompletedAt) || 0);
    totalDelivery.push(isoBetween(timing.waDetectedAt, timing.webhookCompletedAt) || 0);
    browserQueueWait.push(timing.browserQueueWaitMs || 0);
    browserOperation.push(timing.browserOperationMs || 0);
  }

  const report = {
    samples: SAMPLE_COUNT,
    detectionToCaptureMs: summarize('detection → capture', detectionToCapture),
    captureToSpoolMs: summarize('capture → durable spool', captureToSpool),
    webhookLatencyMs: summarize('webhook request', webhookLatency),
    totalInboundDeliveryMs: summarize('detection → ERP ack', totalDelivery),
    browserQueueWaitMs: summarize('browser queue wait', browserQueueWait),
    browserOperationMs: summarize('browser operation', browserOperation),
    spoolStats: spool.getStats(),
  };

  console.log(JSON.stringify(report, null, 2));

  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
