'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createV7WorkerProvider } = require('../../services/drvowa/v7/v7WorkerProvider');
const {
  createOutboundIdempotencyStore,
} = require('../../services/drvowa/outboundIdempotencyStore');
const {
  createOutboundObservationSpool,
} = require('../../services/drvowa/outboundObservationSpool');
const {
  createManagedOutboundObserver,
} = require('../../services/drvowa/managedOutboundObserver');

describe('v7 human takeover observation wiring', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7-obs-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('manual fromMe observation → HUMAN_MANUAL on V7 spool', async () => {
    const provider = createV7WorkerProvider({
      accountKey: 'wa_testtakeover000000000001',
      authBaseDir: tmpDir,
      forkFn: () => {
        throw new Error('fork should not run in this unit test');
      },
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await provider._outboundObservedPoster.observe({
      providerMessageId: 'MID_HUMAN_1',
      phone: '201557994946',
      text: 'manual phone reply',
      occurredAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
    expect(result.origin).toBe('HUMAN_MANUAL');
    const stats = provider._outboundObservationSpool.getStats();
    expect(stats.pending + stats.delivered).toBeGreaterThanOrEqual(1);
  });

  it('API-correlated fromMe → DRVOWA_API (same classifier as V6)', async () => {
    const idem = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'idem.json'),
    });
    idem.reserveSending({
      idempotencyKey: 'k1',
      phone: '201557994946',
      payloadHash: 'h',
    });
    idem.markSent({ idempotencyKey: 'k1', providerMessageId: 'MID_API_1' });

    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'spool.json'),
    });
    const observer = createManagedOutboundObserver({
      accountKey: 'wa_v7api',
      idempotencyStore: idem,
      observationSpool: spool,
      logger: { info() {}, warn() {} },
    });
    const result = await observer.observe({
      providerMessageId: 'MID_API_1',
      phone: '201557994946',
      text: 'api reply',
      occurredAt: new Date().toISOString(),
    });
    expect(result.origin).toBe('DRVOWA_API');
  });

  it('IPC outboundObserved handler enqueues observation', async () => {
    const provider = createV7WorkerProvider({
      accountKey: 'wa_testtakeover000000000003',
      authBaseDir: tmpDir,
      forkFn: () => { throw new Error('no fork'); },
      logger: { info() {}, warn() {}, error() {} },
    });
    provider._handleOutboundObserved({
      providerMessageId: 'MID_IPC_1',
      phone: '201557994946',
      text: 'from ipc',
      occurredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 40));
    const stats = provider._outboundObservationSpool.getStats();
    expect(stats.pending + stats.delivered + stats.unresolved).toBeGreaterThanOrEqual(1);
  });

  it('status exposes outboundObservation fields', () => {
    const provider = createV7WorkerProvider({
      accountKey: 'wa_testtakeover000000000004',
      authBaseDir: tmpDir,
      forkFn: () => { throw new Error('no fork'); },
      logger: { info() {}, warn() {}, error() {} },
    });
    const status = provider.getStatus();
    expect(status.outboundObservation).toMatchObject({
      running: expect.any(Boolean),
      pending: expect.any(Number),
    });
  });

  it('V7 send path wires observeApiOutbound fail-safe', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'services/drvowa/v7/v7WorkerProvider.js'),
      'utf8',
    );
    expect(src).toContain('observeApiOutbound');
    expect(src).toContain('createManagedOutboundObserver');
    expect(src).toContain('createDrvowaOutboundObservationWorker');
    expect(src).toContain('outboundObserved');
  });
});
