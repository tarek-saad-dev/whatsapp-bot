'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createSendQueue } = require('../../services/sendQueue');
const {
  createOutboundIdempotencyStore,
} = require('../../services/drvowa/outboundIdempotencyStore');
const {
  createOutboundObservationSpool,
  ORIGIN,
} = require('../../services/drvowa/outboundObservationSpool');
const {
  sendManagedWithIdempotency,
} = require('../../services/drvowa/managedOutboundSend');
const {
  createOutboundNumberSafety,
} = require('../../services/drvowa/outboundNumberSafety');

describe('managed messaging stress (M4)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-stress-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('per-account concurrency stays 1; accounts parallel; duplicate sends = 0', async () => {
    const ACCOUNT_COUNT = 8;
    const OPS_PER_ACCOUNT = 40;
    const accounts = [];

    for (let a = 0; a < ACCOUNT_COUNT; a += 1) {
      const accountKey = `wa_${a}`;
      const store = createOutboundIdempotencyStore({
        filePath: path.join(tmpDir, accountKey, 'idem.json'),
        maxEntries: 500,
      });
      const queue = createSendQueue({ concurrency: 1, maxQueued: 200 });
      let inFlight = 0;
      let maxInFlight = 0;
      let sendCalls = 0;
      const safety = createOutboundNumberSafety({
        accountKey,
        limits: { perMinute: 1000, perHour: 5000, perDay: 20000, burstLimit: 500 },
      });
      accounts.push({
        accountKey,
        store,
        queue,
        safety,
        get maxInFlight() { return maxInFlight; },
        async send(i) {
          return queue.enqueue(async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
              return await sendManagedWithIdempotency({
                accountKey,
                phone: `20155500000${a}`,
                message: `msg-${i}`,
                idempotencyKey: `${accountKey}:k:${i}`,
                store,
                numberSafety: safety,
                sendFn: async () => {
                  sendCalls += 1;
                  await new Promise((r) => setTimeout(r, 1));
                  return { success: true, messageId: `${accountKey}-M${i}` };
                },
              });
            } finally {
              inFlight -= 1;
            }
          });
        },
        get sendCalls() { return sendCalls; },
      });
    }

    const started = Date.now();
    await Promise.all(accounts.map(async (acct) => {
      const firstWave = [];
      for (let i = 0; i < OPS_PER_ACCOUNT; i += 1) {
        firstWave.push(acct.send(i));
      }
      const firstSettled = await Promise.all(firstWave);
      expect(firstSettled.every((r) => r.success && r.status === 'sent')).toBe(true);
      expect(acct.sendCalls).toBe(OPS_PER_ACCOUNT);

      const dups = await Promise.all([acct.send(0), acct.send(1)]);
      expect(dups.every((r) => r.status === 'duplicate')).toBe(true);
      expect(acct.sendCalls).toBe(OPS_PER_ACCOUNT);
    }));

    for (const acct of accounts) {
      expect(acct.maxInFlight).toBe(1);
    }

    // Restart: SENDING preserved; UNRESOLVED spool survives
    const stuckPath = path.join(tmpDir, 'wa_0', 'idem.json');
    const storeStuck = createOutboundIdempotencyStore({ filePath: stuckPath });
    storeStuck.reserveSending({
      idempotencyKey: 'stuck-restart',
      phone: '201555000000',
      payloadHash: 'h',
    });
    const reloaded = createOutboundIdempotencyStore({ filePath: stuckPath });
    expect(reloaded.get('stuck-restart').state).toBe('SENDING');

    const spoolFile = path.join(tmpDir, 'obs.json');
    const spool = createOutboundObservationSpool({ spoolFile });
    spool.captureOrPromote({
      accountKey: 'wa_0',
      providerMessageId: 'UNRES-1',
      origin: ORIGIN.UNRESOLVED,
      occurredAt: new Date().toISOString(),
    });
    const spool2 = createOutboundObservationSpool({ spoolFile });
    expect(spool2.getStats().unresolved).toBe(1);

    // Capacity: fill with SENDING
    const capStore = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'cap.json'),
      maxEntries: 3,
    });
    capStore.reserveSending({ idempotencyKey: 'A', phone: '1', payloadHash: 'a' });
    capStore.reserveSending({ idempotencyKey: 'B', phone: '1', payloadHash: 'b' });
    capStore.reserveSending({ idempotencyKey: 'C', phone: '1', payloadHash: 'c' });
    let capSends = 0;
    const cap = await sendManagedWithIdempotency({
      accountKey: 'wa_cap',
      phone: '1',
      message: 'd',
      idempotencyKey: 'D',
      store: capStore,
      sendFn: async () => {
        capSends += 1;
        return { success: true, messageId: 'X' };
      },
    });
    expect(cap.code).toBe('OUTBOUND_IDEMPOTENCY_CAPACITY');
    expect(capSends).toBe(0);

    const durationMs = Date.now() - started;
    expect(durationMs).toBeLessThan(60_000);
  });
});
