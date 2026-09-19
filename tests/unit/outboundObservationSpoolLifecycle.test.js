'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  createOutboundObservationSpool,
  STATUS,
  ORIGIN,
} = require('../../services/drvowa/outboundObservationSpool');
const {
  createDrvowaOutboundObservationWorker,
  classifyOutboundObservationOutcome,
  PERSISTENT_404_THRESHOLD,
} = require('../../services/drvowa/drvowaOutboundObservationWorker');

describe('outbound observation spool lifecycle (M1)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-obs-life-m1-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSpool(opts = {}) {
    return createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'outbound-observation-spool.json'),
      maxUnresolvedWarn: 3,
      ...opts,
    });
  }

  function seedPending(spool, id = 'P1') {
    return spool.captureOrPromote({
      accountKey: 'wa_a',
      providerMessageId: id,
      origin: ORIGIN.DRVOWA_API,
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    }).record;
  }

  it('classify: 401/403 permanent; 5xx retry; 404 soft then permanent', () => {
    expect(classifyOutboundObservationOutcome(401)).toBe('permanent');
    expect(classifyOutboundObservationOutcome(403)).toBe('permanent');
    expect(classifyOutboundObservationOutcome(400)).toBe('permanent');
    expect(classifyOutboundObservationOutcome(500)).toBe('retry');
    expect(classifyOutboundObservationOutcome(429)).toBe('retry');
    expect(classifyOutboundObservationOutcome(404, { consecutive404: 0 })).toBe('retry');
    expect(classifyOutboundObservationOutcome(404, { consecutive404: 1 })).toBe('retry');
    expect(classifyOutboundObservationOutcome(404, {
      consecutive404: PERSISTENT_404_THRESHOLD - 1,
    })).toBe('permanent');
  });

  it('first 404 retries; persistent 404 becomes FAILED', async () => {
    const spool = makeSpool();
    seedPending(spool, 'X404');
    const fetchImpl = vi.fn(async () => ({ status: 404 }));
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      backoffMs: [0, 0, 0, 0, 0, 0, 0, 0],
      logger: { info() {}, warn() {} },
    });

    await worker.tick();
    expect(spool.get('X404').status).toBe(STATUS.PENDING);
    expect(spool.get('X404').lastError).toBe('HTTP_404');
    expect(spool.get('X404').consecutive404).toBe(1);

    await worker.tick();
    expect(spool.get('X404').status).toBe(STATUS.PENDING);
    expect(spool.get('X404').consecutive404).toBe(2);

    await worker.tick();
    expect(spool.get('X404').status).toBe(STATUS.FAILED);
    expect(spool.get('X404').consecutive404).toBe(3);
    expect(spool.getPendingForDelivery()).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    worker.stop();
  });

  it('500 then two 404s still retry; third consecutive 404 fails', async () => {
    const spool = makeSpool();
    seedPending(spool, 'MIX');
    const statuses = [500, 404, 404, 404];
    const fetchImpl = vi.fn(async () => ({ status: statuses.shift() }));
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      backoffMs: [0, 0, 0, 0, 0, 0, 0, 0],
      logger: { info() {}, warn() {} },
    });

    await worker.tick(); // 500
    expect(spool.get('MIX').status).toBe(STATUS.PENDING);
    expect(spool.get('MIX').consecutive404).toBe(0);

    await worker.tick(); // 404 #1
    expect(spool.get('MIX').status).toBe(STATUS.PENDING);
    expect(spool.get('MIX').consecutive404).toBe(1);

    await worker.tick(); // 404 #2 — still retry (not 3 consecutive from attempts)
    expect(spool.get('MIX').status).toBe(STATUS.PENDING);
    expect(spool.get('MIX').consecutive404).toBe(2);
    expect(spool.get('MIX').attempts).toBe(3);

    await worker.tick(); // 404 #3 consecutive → FAILED
    expect(spool.get('MIX').status).toBe(STATUS.FAILED);
    expect(spool.get('MIX').consecutive404).toBe(3);
    worker.stop();
  });

  it('404 then 500 resets consecutive404; not permanent on mixed streak', async () => {
    const spool = makeSpool();
    seedPending(spool, 'RST');
    const statuses = [404, 500, 404];
    const fetchImpl = vi.fn(async () => ({ status: statuses.shift() }));
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      backoffMs: [0, 0, 0, 0, 0, 0, 0, 0],
      logger: { info() {}, warn() {} },
    });

    await worker.tick();
    expect(spool.get('RST').consecutive404).toBe(1);
    await worker.tick();
    expect(spool.get('RST').consecutive404).toBe(0);
    expect(spool.get('RST').status).toBe(STATUS.PENDING);
    await worker.tick();
    expect(spool.get('RST').consecutive404).toBe(1);
    expect(spool.get('RST').status).toBe(STATUS.PENDING);
    worker.stop();
  });

  it('restart after two 404s; third consecutive 404 becomes permanent', async () => {
    const spoolFile = path.join(tmpDir, 'restart-404.json');
    const spool1 = createOutboundObservationSpool({ spoolFile });
    seedPending(spool1, 'R404');
    const fetchImpl = vi.fn(async () => ({ status: 404 }));
    const worker1 = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool: spool1,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      backoffMs: [0, 0, 0, 0, 0, 0, 0, 0],
      logger: { info() {}, warn() {} },
    });
    await worker1.tick();
    await worker1.tick();
    expect(spool1.get('R404').consecutive404).toBe(2);
    worker1.stop();

    const spool2 = createOutboundObservationSpool({ spoolFile });
    expect(spool2.get('R404').consecutive404).toBe(2);
    const worker2 = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool: spool2,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      backoffMs: [0, 0, 0, 0, 0, 0, 0, 0],
      logger: { info() {}, warn() {} },
    });
    await worker2.tick();
    expect(spool2.get('R404').status).toBe(STATUS.FAILED);
    expect(spool2.get('R404').consecutive404).toBe(3);
    worker2.stop();
  });

  it('401 fails permanently on first attempt', async () => {
    const spool = makeSpool();
    seedPending(spool, 'X401');
    const fetchImpl = vi.fn(async () => ({ status: 401 }));
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      logger: { info() {}, warn() {} },
    });
    await worker.tick();
    expect(spool.get('X401').status).toBe(STATUS.FAILED);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it('5xx retries without failing immediately', async () => {
    const spool = makeSpool();
    seedPending(spool, 'X500');
    const fetchImpl = vi.fn(async () => ({ status: 503 }));
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      backoffMs: [0, 0, 0],
      logger: { info() {}, warn() {} },
    });
    await worker.tick();
    expect(spool.get('X500').status).toBe(STATUS.PENDING);
    await worker.tick();
    expect(spool.get('X500').status).toBe(STATUS.PENDING);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('UNRESOLVED never delivered; restart persists hold', async () => {
    const spoolFile = path.join(tmpDir, 'spool.json');
    const spool1 = createOutboundObservationSpool({ spoolFile, maxUnresolvedWarn: 2 });
    spool1.captureOrPromote({
      accountKey: 'wa_a',
      providerMessageId: 'U1',
      origin: ORIGIN.UNRESOLVED,
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    });
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const worker = createDrvowaOutboundObservationWorker({
      accountKey: 'wa_a',
      spool: spool1,
      fetchImpl,
      runtimeToken: 't',
      ingestUrl: 'http://127.0.0.1:9/x',
      enabled: () => true,
      logger: { info() {}, warn() {} },
    });
    await worker.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    worker.stop();

    const spool2 = createOutboundObservationSpool({ spoolFile, maxUnresolvedWarn: 2 });
    expect(spool2.get('U1').status).toBe(STATUS.UNRESOLVED);
    expect(spool2.getStats().unresolved).toBe(1);
  });

  it('delivered cleanup respects maxDelivered; stats include unresolvedSaturated', async () => {
    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'spool.json'),
      maxDelivered: 2,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maxUnresolvedWarn: 2,
    });
    for (let i = 0; i < 4; i += 1) {
      spool.captureOrPromote({
        accountKey: 'wa_a',
        providerMessageId: `D${i}`,
        origin: ORIGIN.HUMAN_MANUAL,
        phone: '201555111111',
        occurredAt: new Date().toISOString(),
      });
      spool.markDelivered(`D${i}`);
    }
    expect(spool.getStats().delivered).toBeLessThanOrEqual(2);

    spool.captureOrPromote({
      accountKey: 'wa_a',
      providerMessageId: 'U1',
      origin: ORIGIN.UNRESOLVED,
      occurredAt: new Date().toISOString(),
    });
    spool.captureOrPromote({
      accountKey: 'wa_a',
      providerMessageId: 'U2',
      origin: ORIGIN.UNRESOLVED,
      occurredAt: new Date().toISOString(),
    });
    expect(spool.getStats().unresolvedSaturated).toBe(true);
  });

  it('successful delivery posts once; duplicate tick does not re-post', async () => {
    const spool = makeSpool();
    seedPending(spool, 'ONCE');
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
    await worker.tick();
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(spool.get('ONCE').status).toBe(STATUS.DELIVERED);
    worker.stop();
  });
});
