import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  createOutboundIdempotencyStore,
} = require('../../services/drvowa/outboundIdempotencyStore');
const {
  createOutboundObservationSpool,
} = require('../../services/drvowa/outboundObservationSpool');
const {
  createManagedOutboundObserver,
} = require('../../services/drvowa/managedOutboundObserver');
const {
  createDrvowaOutboundObservationWorker,
} = require('../../services/drvowa/drvowaOutboundObservationWorker');
const {
  createOutboundObservedPoster,
} = require('../../services/inbox/outboundObservedPoster');
const {
  isOutboundObservationDeliveryEnabled,
} = require('../../services/drvowa/s2sAuth');

describe('Phase 3B Part 2A managed outbound observation', () => {
  let tmpDir;
  let prevEnabled;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-out-obs-'));
    prevEnabled = process.env.DRVOWA_OUTBOUND_OBSERVATION_ENABLED;
    delete process.env.DRVOWA_OUTBOUND_OBSERVATION_ENABLED;
  });

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.DRVOWA_OUTBOUND_OBSERVATION_ENABLED;
    else process.env.DRVOWA_OUTBOUND_OBSERVATION_ENABLED = prevEnabled;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('14. matching fromMe is classified DRVOWA_API', async () => {
    const idem = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    idem.reserveSending({
      idempotencyKey: 'k1',
      phone: '201555111111',
      payloadHash: 'h',
    });
    idem.markSent({ idempotencyKey: 'k1', providerMessageId: 'API-MSG-1' });

    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
    });
    const observer = createManagedOutboundObserver({
      accountKey: 'wa_a',
      idempotencyStore: idem,
      observationSpool: spool,
      logger: { info() {}, warn() {} },
    });
    const result = await observer.observe({
      providerMessageId: 'API-MSG-1',
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('DRVOWA_API');
    expect(spool.getStats().pending).toBe(1);
  });

  it('15. unknown fromMe is classified HUMAN_MANUAL', async () => {
    const idem = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
    });
    const observer = createManagedOutboundObserver({
      accountKey: 'wa_a',
      idempotencyStore: idem,
      observationSpool: spool,
      logger: { info() {}, warn() {} },
    });
    const result = await observer.observe({
      providerMessageId: 'HUMAN-MSG-1',
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('HUMAN_MANUAL');
  });

  it('16. outbound observation persisted durably', async () => {
    const spoolFile = path.join(tmpDir, 'outbound-observation-spool.json');
    const spool1 = createOutboundObservationSpool({ spoolFile });
    spool1.capture({
      accountKey: 'wa_a',
      providerMessageId: 'OBS-1',
      origin: 'HUMAN_MANUAL',
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    });
    const spool2 = createOutboundObservationSpool({ spoolFile });
    expect(spool2.getStats().pending).toBe(1);
    expect(spool2.getPendingForDelivery()[0].providerMessageId).toBe('OBS-1');
  });

  it('17. observation delivery disabled by default', () => {
    expect(isOutboundObservationDeliveryEnabled()).toBe(false);
  });

  it('18. disabled observation does not hammer SaaS endpoint', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 404, json: async () => ({}) }));
    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
    });
    spool.capture({
      accountKey: 'wa_a',
      providerMessageId: 'OBS-2',
      origin: 'HUMAN_MANUAL',
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    });
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool,
      fetchImpl,
      runtimeToken: 'token',
      ingestUrl: 'http://127.0.0.1:3100/api/runtime/whatsapp/outbound-observed',
      enabled: () => false,
      logger: { info() {}, warn() {} },
    });
    worker.start();
    await worker.tick();
    await worker.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(worker.getStatus().deliveryEnabled).toBe(false);
    expect(worker.getStatus().fetchAttempts).toBe(0);
    worker.stop();
  });

  it('19. legacy outbound observation unchanged', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      json: async () => ({ ok: true }),
    }));
    const poster = createOutboundObservedPoster({
      webhookUrl: 'http://127.0.0.1:9999/legacy',
      webhookToken: 'legacy-token',
      fetchImpl,
    });
    const result = await poster.observe({
      providerMessageId: 'LEGACY-1',
      phone: '201555111111',
      text: 'hello',
      occurredAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('2A.1-6/7/8/9. matching fromMe reconciles SENDING → SENT as DRVOWA_API', async () => {
    const { hashPayload, STATES } = require('../../services/drvowa/outboundIdempotencyStore');
    const {
      sendManagedWithIdempotency,
    } = require('../../services/drvowa/managedOutboundSend');

    const filePath = path.join(tmpDir, 'outbound-idempotency.json');
    const idem = createOutboundIdempotencyStore({ filePath });
    const message = 'reconcile me';
    const phone = '201555111111';
    idem.reserveSending({
      idempotencyKey: 'key-recon',
      phone,
      payloadHash: hashPayload({ phone, message }),
    });
    expect(idem.get('key-recon').state).toBe(STATES.SENDING);

    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
    });
    const observer = createManagedOutboundObserver({
      accountKey: 'wa_a',
      idempotencyStore: idem,
      observationSpool: spool,
      logger: { info() {}, warn() {} },
    });
    const observed = await observer.observe({
      providerMessageId: 'RECON-MSG-1',
      phone,
      text: message,
      occurredAt: new Date().toISOString(),
    });
    expect(observed.origin).toBe('DRVOWA_API');
    expect(idem.get('key-recon').state).toBe(STATES.SENT);
    expect(idem.get('key-recon').providerMessageId).toBe('RECON-MSG-1');
    expect(idem.isApiOrigin('RECON-MSG-1')).toBe(true);

    const dumped = JSON.stringify(idem.dumpEntries());
    expect(dumped).not.toContain(message);

    const sendFn = vi.fn(async () => ({ success: true, messageId: 'SHOULD-NOT' }));
    const replay = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone,
      message,
      idempotencyKey: 'key-recon',
      store: idem,
      sendFn,
    });
    expect(replay.status).toBe('duplicate');
    expect(replay.messageId).toBe('RECON-MSG-1');
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('2A.1-10. same-phone text mismatch is UNRESOLVED (not HUMAN_MANUAL)', async () => {
    const { hashPayload, STATES } = require('../../services/drvowa/outboundIdempotencyStore');
    const idem = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    idem.reserveSending({
      idempotencyKey: 'key-other',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'api text' }),
    });
    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
    });
    const observer = createManagedOutboundObserver({
      accountKey: 'wa_a',
      idempotencyStore: idem,
      observationSpool: spool,
      logger: { info() {}, warn() {} },
    });
    const result = await observer.observe({
      providerMessageId: 'HUMAN-OTHER',
      phone: '201555111111',
      text: 'totally different human text',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('UNRESOLVED');
    expect(spool.getStats().unresolved).toBe(1);
    expect(spool.getPendingForDelivery()).toHaveLength(0);
    expect(idem.get('key-other').state).toBe(STATES.SENDING);
    expect(idem.isApiOrigin('HUMAN-OTHER')).toBe(false);
  });

  it('2A.1-11. ambiguous multiple candidate match is UNRESOLVED and never binds', async () => {
    const { hashPayload, STATES } = require('../../services/drvowa/outboundIdempotencyStore');
    const idem = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    const phone = '201555111111';
    const message = 'same text';
    const payloadHash = hashPayload({ phone, message });
    idem.reserveSending({ idempotencyKey: 'key-a', phone, payloadHash });
    idem.reserveSending({ idempotencyKey: 'key-b', phone, payloadHash });

    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
    });
    const observer = createManagedOutboundObserver({
      accountKey: 'wa_a',
      idempotencyStore: idem,
      observationSpool: spool,
      logger: { info() {}, warn() {} },
    });
    const result = await observer.observe({
      providerMessageId: 'MULTI-1',
      phone,
      text: message,
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('UNRESOLVED');
    expect(idem.get('key-a').state).toBe(STATES.SENDING);
    expect(idem.get('key-b').state).toBe(STATES.SENDING);
    expect(idem.isApiOrigin('MULTI-1')).toBe(false);
    expect(spool.getPendingForDelivery()).toHaveLength(0);
  });
});

describe('managed API send path queues DRVOWA_API observation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-api-obs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function harness() {
    const {
      sendManagedWithIdempotency,
    } = require('../../services/drvowa/managedOutboundSend');
    const idem = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
    });
    const logs = [];
    const logger = {
      info(...args) { logs.push(args); },
      warn(...args) { logs.push(args); },
    };
    const observer = createManagedOutboundObserver({
      accountKey: 'wa_a',
      idempotencyStore: idem,
      observationSpool: spool,
      logger,
    });
    return { sendManagedWithIdempotency, idem, spool, observer, logs, logger };
  }

  it('successful managed send queues exactly one DRVOWA_API observation', async () => {
    const { sendManagedWithIdempotency, idem, spool, observer, logs, logger } = harness();
    const sendFn = vi.fn(async () => ({
      success: true,
      status: 'sent',
      messageId: '3EB014C5C721F3723B90D2',
    }));

    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hello api',
      idempotencyKey: 'ai:job-1',
      store: idem,
      sendFn,
      observeApiOutbound: (payload) => observer.observe(payload),
      logger,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('3EB014C5C721F3723B90D2');
    expect(spool.getStats().total).toBe(1);
    expect(spool.getStats().pending).toBe(1);
    const pending = spool.getPendingForDelivery();
    expect(pending).toHaveLength(1);
    expect(pending[0].providerMessageId).toBe('3EB014C5C721F3723B90D2');
    expect(pending[0].origin).toBe('DRVOWA_API');
    expect(logs.some((a) => String(a[0]).includes('api_observation_queued'))).toBe(true);
  });

  it('duplicate idempotency retry does not create duplicate observation record', async () => {
    const { sendManagedWithIdempotency, idem, spool, observer, logger } = harness();
    const sendFn = vi.fn(async () => ({
      success: true,
      messageId: '3EB0E4F5786EEBBD25AC72',
    }));

    await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hello',
      idempotencyKey: 'ai:job-2',
      store: idem,
      sendFn,
      observeApiOutbound: (payload) => observer.observe(payload),
      logger,
    });
    expect(spool.getStats().total).toBe(1);

    const dup = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hello',
      idempotencyKey: 'ai:job-2',
      store: idem,
      sendFn,
      observeApiOutbound: (payload) => observer.observe(payload),
      logger,
    });
    expect(dup.status).toBe('duplicate');
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(spool.getStats().total).toBe(1);
    expect(spool.getPendingForDelivery()[0].origin).toBe('DRVOWA_API');
  });

  it('later messages.upsert fromMe echo stays one DRVOWA_API observation', async () => {
    const { sendManagedWithIdempotency, idem, spool, observer, logger } = harness();
    const providerMessageId = '3EB04BB55F2A17E5DF3CD8';

    await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'echo later',
      idempotencyKey: 'ai:job-3',
      store: idem,
      sendFn: async () => ({ success: true, messageId: providerMessageId }),
      observeApiOutbound: (payload) => observer.observe(payload),
      logger,
    });
    expect(spool.getStats().total).toBe(1);

    // Baileys later echoes the same fromMe message
    const echo = await observer.observe({
      providerMessageId,
      phone: '201555111111',
      text: 'echo later',
      occurredAt: new Date().toISOString(),
    });
    expect(echo.origin).toBe('DRVOWA_API');
    expect(echo.duplicate).toBe(true);
    expect(spool.getStats().total).toBe(1);
    expect(spool.getPendingForDelivery()[0].origin).toBe('DRVOWA_API');
  });

  it('manual fromMe outbound with unknown providerMessageId is HUMAN_MANUAL', async () => {
    const { spool, observer } = harness();
    const result = await observer.observe({
      providerMessageId: '2AEE5405DD992F08FA25',
      phone: '201555111111',
      text: 'typed on phone',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('HUMAN_MANUAL');
    expect(spool.getStats().total).toBe(1);
    expect(spool.getPendingForDelivery()[0].origin).toBe('HUMAN_MANUAL');
  });

  it('ambiguous send queues no observation', async () => {
    const { sendManagedWithIdempotency, idem, spool, observer, logger } = harness();
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'maybe',
      idempotencyKey: 'ai:ambiguous',
      store: idem,
      sendFn: async () => ({
        success: false,
        outcomeUnknown: true,
        code: 'OUTBOUND_RESULT_UNKNOWN',
        error: 'unknown',
      }),
      observeApiOutbound: (payload) => observer.observe(payload),
      logger,
    });
    expect(result.status).toBe('unknown');
    expect(spool.getStats().total).toBe(0);
  });

  it('definitive failure queues no observation', async () => {
    const { sendManagedWithIdempotency, idem, spool, observer, logger } = harness();
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'nope',
      idempotencyKey: 'ai:fail',
      store: idem,
      sendFn: async () => ({
        success: false,
        sendAttempted: false,
        code: 'NOT_READY',
        error: 'Account is not READY',
      }),
      observeApiOutbound: (payload) => observer.observe(payload),
      logger,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('NOT_READY');
    expect(spool.getStats().total).toBe(0);
  });

  it('observer/spool failure after successful send still returns success', async () => {
    const { sendManagedWithIdempotency, idem, logs, logger } = harness();
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'sent anyway',
      idempotencyKey: 'ai:obs-fail',
      store: idem,
      sendFn: async () => ({
        success: true,
        messageId: '3EB0OBSFAIL0000000001',
      }),
      observeApiOutbound: async () => {
        throw new Error('spool disk full');
      },
      logger,
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('3EB0OBSFAIL0000000001');
    expect(logs.some((a) => String(a[0]).includes('api_observation_failed'))).toBe(true);
    // Must not log message text
    const flat = JSON.stringify(logs);
    expect(flat).not.toContain('sent anyway');
  });

  it('success without providerMessageId queues no observation', async () => {
    const { sendManagedWithIdempotency, idem, spool, observer, logger } = harness();
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'no id',
      idempotencyKey: 'ai:noid',
      store: idem,
      sendFn: async () => ({ success: true, messageId: null }),
      observeApiOutbound: (payload) => observer.observe(payload),
      logger,
    });
    expect(result.status).toBe('unknown');
    expect(spool.getStats().total).toBe(0);
  });
});
