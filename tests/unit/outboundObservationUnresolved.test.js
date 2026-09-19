'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  createOutboundIdempotencyStore,
  hashPayload,
  STATES,
} = require('../../services/drvowa/outboundIdempotencyStore');
const {
  createOutboundObservationSpool,
  STATUS,
  ORIGIN,
} = require('../../services/drvowa/outboundObservationSpool');
const {
  createManagedOutboundObserver,
} = require('../../services/drvowa/managedOutboundObserver');
const {
  createDrvowaOutboundObservationWorker,
} = require('../../services/drvowa/drvowaOutboundObservationWorker');
const {
  sendManagedWithIdempotency,
} = require('../../services/drvowa/managedOutboundSend');

describe('outbound observation UNRESOLVED classification', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-obs-unres-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function harness({ worker = false, fetchImpl = null } = {}) {
    const idem = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
    });
    const logger = { info() {}, warn() {} };
    let observationWorker = null;
    if (worker) {
      observationWorker = createDrvowaOutboundObservationWorker({
        accountKey: 'wa_a',
        spool,
        fetchImpl: fetchImpl || vi.fn(async () => ({ status: 200, json: async () => ({ ok: true }) })),
        runtimeToken: 'token',
        ingestUrl: 'http://127.0.0.1:3100/api/runtime/whatsapp/outbound-observed',
        enabled: () => true,
        logger,
      });
    }
    const observer = createManagedOutboundObserver({
      accountKey: 'wa_a',
      idempotencyStore: idem,
      observationSpool: spool,
      observationWorker,
      logger,
    });
    return { idem, spool, observer, observationWorker, fetchImpl };
  }

  it('A. known API providerMessageId → DRVOWA_API pending', async () => {
    const { idem, spool, observer } = harness();
    idem.reserveSending({ idempotencyKey: 'k1', phone: '201555111111', payloadHash: 'h' });
    idem.markSent({ idempotencyKey: 'k1', providerMessageId: 'API-KNOWN' });

    const result = await observer.observe({
      providerMessageId: 'API-KNOWN',
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('DRVOWA_API');
    expect(spool.getStats().pending).toBe(1);
    expect(spool.getPendingForDelivery()[0].origin).toBe('DRVOWA_API');
  });

  it('B. exact single SENDING reconciliation → DRVOWA_API', async () => {
    const { idem, spool, observer } = harness();
    const phone = '201555111111';
    const text = 'exact match';
    idem.reserveSending({
      idempotencyKey: 'k-recon',
      phone,
      payloadHash: hashPayload({ phone, message: text }),
    });

    const result = await observer.observe({
      providerMessageId: 'RECON-1',
      phone,
      text,
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('DRVOWA_API');
    expect(idem.get('k-recon').state).toBe(STATES.SENT);
    expect(idem.isApiOrigin('RECON-1')).toBe(true);
    expect(spool.getPendingForDelivery()).toHaveLength(1);
  });

  it('C. multiple exact candidates → UNRESOLVED, no bind, no delivery', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({}) }));
    const { idem, spool, observer, observationWorker } = harness({ worker: true, fetchImpl });
    const phone = '201555111111';
    const text = 'dup text';
    const payloadHash = hashPayload({ phone, message: text });
    idem.reserveSending({ idempotencyKey: 'a', phone, payloadHash });
    idem.reserveSending({ idempotencyKey: 'b', phone, payloadHash });

    const result = await observer.observe({
      providerMessageId: 'MULTI',
      phone,
      text,
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('UNRESOLVED');
    expect(idem.get('a').state).toBe(STATES.SENDING);
    expect(idem.get('b').state).toBe(STATES.SENDING);
    expect(spool.getPendingForDelivery()).toHaveLength(0);
    observationWorker.start();
    await observationWorker.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    observationWorker.stop();
  });

  it('D. same phone / text mismatch → HUMAN_MANUAL (plain-text evidence)', async () => {
    const { idem, spool, observer } = harness();
    idem.reserveSending({
      idempotencyKey: 'k',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'api' }),
    });
    const result = await observer.observe({
      providerMessageId: 'MISMATCH',
      phone: '201555111111',
      text: 'other text',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('HUMAN_MANUAL');
    expect(spool.getStats().pending).toBe(1);
    expect(spool.getPendingForDelivery()[0].origin).toBe('HUMAN_MANUAL');
  });

  it('E. same phone / null text → UNRESOLVED', async () => {
    const { idem, spool, observer } = harness();
    idem.reserveSending({
      idempotencyKey: 'k',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'api' }),
    });
    const result = await observer.observe({
      providerMessageId: 'NULLTXT',
      phone: '201555111111',
      text: null,
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('UNRESOLVED');
    expect(spool.getPendingForDelivery()).toHaveLength(0);
  });

  it('F. unrelated phone B is HUMAN_MANUAL while SENDING exists for A', async () => {
    const { idem, spool, observer } = harness();
    idem.reserveSending({
      idempotencyKey: 'k-a',
      phone: '201555111111',
      payloadHash: 'ha',
    });
    const result = await observer.observe({
      providerMessageId: 'HUMAN-B',
      phone: '201555999999',
      text: 'typed on phone',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('HUMAN_MANUAL');
    expect(spool.getPendingForDelivery()[0].origin).toBe('HUMAN_MANUAL');
    expect(idem.get('k-a').state).toBe(STATES.SENDING);
  });

  it('G. no API possibility → HUMAN_MANUAL', async () => {
    const { spool, observer } = harness();
    const result = await observer.observe({
      providerMessageId: 'PURE-HUMAN',
      phone: '201555111111',
      text: 'hello',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('HUMAN_MANUAL');
    expect(spool.getStats().pending).toBe(1);
  });

  it('H. UNRESOLVED survives restart and is not delivered', async () => {
    const spoolFile = path.join(tmpDir, 'outbound-observation-spool.json');
    const spool1 = createOutboundObservationSpool({ spoolFile });
    spool1.captureOrPromote({
      accountKey: 'wa_a',
      providerMessageId: 'HOLD-1',
      origin: ORIGIN.UNRESOLVED,
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    });
    expect(spool1.getStats().unresolved).toBe(1);

    const spool2 = createOutboundObservationSpool({ spoolFile });
    expect(spool2.getStats().unresolved).toBe(1);
    expect(spool2.get('HOLD-1').origin).toBe('UNRESOLVED');
    expect(spool2.get('HOLD-1').status).toBe(STATUS.UNRESOLVED);
    expect(spool2.getPendingForDelivery()).toHaveLength(0);

    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool: spool2,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      logger: { info() {}, warn() {} },
    });
    worker.start();
    await worker.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(worker.getStatus().fetchAttempts).toBe(0);
    worker.stop();
  });

  it('I. late API promotion UNRESOLVED → DRVOWA_API → one SaaS POST', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true }) }));
    const { idem, spool, observer } = harness();

    // Early ambiguous capture
    idem.reserveSending({
      idempotencyKey: 'k1',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'later' }),
    });
    idem.reserveSending({
      idempotencyKey: 'k2',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'later' }),
    });
    const early = await observer.observe({
      providerMessageId: 'LATE-X',
      phone: '201555111111',
      text: 'later',
      occurredAt: new Date().toISOString(),
    });
    expect(early.origin).toBe('UNRESOLVED');
    expect(spool.getStats().total).toBe(1);
    expect(spool.getStats().unresolved).toBe(1);

    idem.clearSending('k2');
    idem.markSent({ idempotencyKey: 'k1', providerMessageId: 'LATE-X' });

    const late = await observer.observe({
      providerMessageId: 'LATE-X',
      phone: '201555111111',
      text: 'later',
      occurredAt: new Date().toISOString(),
    });
    expect(late.origin).toBe('DRVOWA_API');
    expect(late.promoted).toBe(true);
    expect(spool.getStats().total).toBe(1);
    expect(spool.getStats().unresolved).toBe(0);
    expect(spool.getStats().pending).toBe(1);
    expect(spool.getPendingForDelivery()).toHaveLength(1);

    const observationWorker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool,
      fetchImpl,
      runtimeToken: 'token',
      ingestUrl: 'http://127.0.0.1:3100/api/runtime/whatsapp/outbound-observed',
      enabled: () => true,
      logger: { info() {}, warn() {} },
    });
    observationWorker.start();
    await observationWorker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.origin).toBe('DRVOWA_API');
    expect(body.providerMessageId).toBe('LATE-X');
    await observationWorker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    observationWorker.stop();
  });

  it('J. API cannot be downgraded to HUMAN_MANUAL', async () => {
    const { idem, spool, observer } = harness();
    idem.reserveSending({ idempotencyKey: 'k', phone: '201555111111', payloadHash: 'h' });
    idem.markSent({ idempotencyKey: 'k', providerMessageId: 'API-KEEP' });

    await observer.observe({
      providerMessageId: 'API-KEEP',
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    });
    expect(spool.get('API-KEEP').origin).toBe('DRVOWA_API');

    // Simulate later echo that would otherwise look human (no SENDING left)
    const again = await observer.observe({
      providerMessageId: 'API-KEEP',
      phone: '201555111111',
      text: 'whatever',
      occurredAt: new Date().toISOString(),
    });
    expect(again.origin).toBe('DRVOWA_API');
    expect(again.duplicate).toBe(true);
    expect(spool.getStats().total).toBe(1);
    expect(spool.get('API-KEEP').origin).toBe('DRVOWA_API');
  });

  it('K. genuine manual with no API ambiguity → HUMAN_MANUAL delivery', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const { spool, observer, observationWorker } = harness({ worker: true, fetchImpl });
    const result = await observer.observe({
      providerMessageId: 'MANUAL-1',
      phone: '201555111111',
      text: 'hi',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('HUMAN_MANUAL');
    observationWorker.start();
    await observationWorker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).origin).toBe('HUMAN_MANUAL');
    expect(spool.getStats().delivered).toBe(1);
    observationWorker.stop();
  });
});

describe('outbound observation worker/stats/managed send (L/M/N)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-obs-w-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('L/M. worker fetchAttempts 0 for unresolved; stats accurate', async () => {
    const idem = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
    });
    idem.reserveSending({
      idempotencyKey: 'a',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'x' }),
    });
    idem.reserveSending({
      idempotencyKey: 'b',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'x' }),
    });

    const observer = createManagedOutboundObserver({
      accountKey: 'wa_a',
      idempotencyStore: idem,
      observationSpool: spool,
      logger: { info() {}, warn() {} },
    });

    await observer.observe({
      providerMessageId: 'U1',
      phone: '201555111111',
      text: 'x',
      occurredAt: new Date().toISOString(),
    });
    await observer.observe({
      providerMessageId: 'H1',
      phone: '201555222222',
      text: 'manual',
      occurredAt: new Date().toISOString(),
    });

    expect(spool.getStats()).toMatchObject({
      unresolved: 1,
      pending: 1,
      total: 2,
    });

    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      logger: { info() {}, warn() {} },
    });
    worker.start();
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(worker.getStatus().fetchAttempts).toBe(1);
    expect(worker.getStatus().unresolved).toBe(1);
    expect(worker.getStatus().pending).toBe(0);
    expect(worker.getStatus().delivered).toBe(1);
    worker.stop();
  });

  it('N. successful managed send still queues exactly one DRVOWA_API observation', async () => {
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

    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hello',
      idempotencyKey: 'ai:n1',
      store: idem,
      sendFn: async () => ({ success: true, messageId: 'SEND-N1' }),
      observeApiOutbound: (payload) => observer.observe(payload),
    });
    expect(result.success).toBe(true);
    expect(spool.getStats().total).toBe(1);
    expect(spool.getPendingForDelivery()[0].origin).toBe('DRVOWA_API');
    expect(spool.getPendingForDelivery()[0].providerMessageId).toBe('SEND-N1');
  });
});

describe('UNRESOLVED lifecycle promotions', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-obs-life-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('B/C/D/E/I. UNRESOLVED → HUMAN_MANUAL after ambiguity cleared; one POST', async () => {
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

    // Ambiguous API SENDING for phone A (null-text human cannot resolve)
    idem.reserveSending({
      idempotencyKey: 'api-stuck',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'api pending' }),
    });

    const first = await observer.observe({
      providerMessageId: 'HUMAN-H',
      phone: '201555111111',
      text: null,
      occurredAt: new Date().toISOString(),
    });
    expect(first.origin).toBe('UNRESOLVED');
    expect(spool.getStats().unresolved).toBe(1);
    expect(spool.get('HUMAN-H').providerMessageId).toBe('HUMAN-H');

    // Ambiguity cleared (SENDING resolved/cleared — not pruned silently as SENDING forever case,
    // but operator/reconcile path cleared the reservation)
    idem.clearSending('api-stuck');
    expect(idem.hasSendingForPhone('201555111111')).toBe(false);

    const second = await observer.observe({
      providerMessageId: 'HUMAN-H',
      phone: '201555111111',
      text: null,
      occurredAt: new Date().toISOString(),
    });
    expect(second.origin).toBe('HUMAN_MANUAL');
    expect(second.promoted).toBe(true);
    expect(spool.getStats().total).toBe(1);
    expect(spool.getStats().unresolved).toBe(0);
    expect(spool.getStats().pending).toBe(1);
    expect(spool.get('HUMAN-H').origin).toBe('HUMAN_MANUAL');

    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      logger: { info() {}, warn() {} },
    });
    worker.start();
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).origin).toBe('HUMAN_MANUAL');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).providerMessageId).toBe('HUMAN-H');

    // Duplicate observe must not POST again
    await observer.observe({
      providerMessageId: 'HUMAN-H',
      phone: '201555111111',
      text: null,
      occurredAt: new Date().toISOString(),
    });
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(spool.getStats().total).toBe(1);
    worker.stop();
  });

  it('G. HUMAN_MANUAL cannot silently flip to API', async () => {
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

    await observer.observe({
      providerMessageId: 'H-KEEP',
      phone: '201555111111',
      text: 'manual',
      occurredAt: new Date().toISOString(),
    });
    expect(spool.get('H-KEEP').origin).toBe('HUMAN_MANUAL');

    idem.reserveSending({ idempotencyKey: 'k', phone: '201555111111', payloadHash: 'h' });
    idem.markSent({ idempotencyKey: 'k', providerMessageId: 'H-KEEP' });

    const again = await observer.observe({
      providerMessageId: 'H-KEEP',
      phone: '201555111111',
      text: 'manual',
      occurredAt: new Date().toISOString(),
    });
    expect(again.origin).toBe('HUMAN_MANUAL');
    expect(spool.get('H-KEEP').origin).toBe('HUMAN_MANUAL');
  });

  it('H. still-ambiguous observation remains UNRESOLVED', async () => {
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
    const phone = '201555111111';
    const text = 'same';
    const payloadHash = hashPayload({ phone, message: text });
    idem.reserveSending({ idempotencyKey: 'a', phone, payloadHash });
    idem.reserveSending({ idempotencyKey: 'b', phone, payloadHash });

    const first = await observer.observe({
      providerMessageId: 'STILL-AMB',
      phone,
      text,
      occurredAt: new Date().toISOString(),
    });
    expect(first.origin).toBe('UNRESOLVED');

    const second = await observer.observe({
      providerMessageId: 'STILL-AMB',
      phone,
      text,
      occurredAt: new Date().toISOString(),
    });
    expect(second.origin).toBe('UNRESOLVED');
    expect(second.promoted).toBe(false);
    expect(spool.getStats().unresolved).toBe(1);
    expect(spool.getStats().oldestUnresolvedCapturedAt).toBeTruthy();
  });
});
