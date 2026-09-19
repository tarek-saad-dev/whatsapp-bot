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
});
