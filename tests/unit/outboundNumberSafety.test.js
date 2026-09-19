'use strict';

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createOutboundNumberSafety,
  STATES,
} = require('../../services/drvowa/outboundNumberSafety');
const {
  createOutboundIdempotencyStore,
  hashPayload,
} = require('../../services/drvowa/outboundIdempotencyStore');
const {
  sendManagedWithIdempotency,
} = require('../../services/drvowa/managedOutboundSend');

describe('outbound number safety (M5)', () => {
  let tmpDir;
  let clock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-ns-'));
    clock = Date.now();
  });

  function safety(limits = {}) {
    return createOutboundNumberSafety({
      accountKey: 'wa_a',
      now: () => clock,
      limits: {
        perMinute: 5,
        perHour: 20,
        perDay: 50,
        burstLimit: 3,
        burstWindowMs: 10_000,
        fanOutUniquePerHour: 5,
        repeatedContentLimit: 3,
        cooldownMs: 60_000,
        ...limits,
      },
    });
  }

  it('normal reply allowed and counters persist on same instance', () => {
    const guard = safety();
    const a = guard.check({ phone: '201555111111', message: 'hi' });
    expect(a.allowed).toBe(true);
    guard.recordSend({ phone: '201555111111', message: 'hi' });
    expect(guard.getStatus().minuteCount).toBe(1);
    guard.recordSend({ phone: '201555111111', message: 'hi2' });
    expect(guard.getStatus().minuteCount).toBe(2);
  });

  it('burst triggers cooldown and blocks before sendFn', async () => {
    const guard = safety({ burstLimit: 2 });
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'idem.json'),
    });
    let sendCalls = 0;
    for (let i = 0; i < 2; i += 1) {
      const r = await sendManagedWithIdempotency({
        accountKey: 'wa_a',
        phone: '201555111111',
        message: `m${i}`,
        idempotencyKey: `k${i}`,
        store,
        numberSafety: guard,
        sendFn: async () => {
          sendCalls += 1;
          return { success: true, messageId: `M${i}` };
        },
      });
      expect(r.success).toBe(true);
    }
    const blocked = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'm3',
      idempotencyKey: 'k3',
      store,
      numberSafety: guard,
      sendFn: async () => {
        sendCalls += 1;
        return { success: true, messageId: 'NO' };
      },
    });
    expect(blocked.code).toBe('OUTBOUND_NUMBER_SAFETY');
    expect(blocked.sendAttempted).toBe(false);
    expect(blocked.outcomeUnknown).toBe(false);
    expect(sendCalls).toBe(2);
    expect(store.get('k3')).toBeNull();
  });

  it('account A state does not affect account B', () => {
    const a = createOutboundNumberSafety({ accountKey: 'wa_a', now: () => clock, limits: { burstLimit: 1, cooldownMs: 60_000 } });
    const b = createOutboundNumberSafety({ accountKey: 'wa_b', now: () => clock, limits: { burstLimit: 1, cooldownMs: 60_000 } });
    a.recordSend({ phone: '1', message: 'x' });
    expect(a.check({ phone: '1', message: 'y' }).allowed).toBe(false);
    expect(b.check({ phone: '1', message: 'y' }).allowed).toBe(true);
  });

  it('SENT duplicate replay skips safety and does not consume quota', async () => {
    const guard = safety({ burstLimit: 1, perMinute: 1 });
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'idem2.json'),
    });
    await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'once',
      idempotencyKey: 'dup',
      store,
      numberSafety: guard,
      sendFn: async () => ({ success: true, messageId: 'MID' }),
    });
    expect(guard.getStatus().minuteCount).toBe(1);
    // At limit — NEW would fail, but duplicate must succeed without quota bump
    const dup = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'once',
      idempotencyKey: 'dup',
      store,
      numberSafety: guard,
      sendFn: async () => ({ success: true, messageId: 'NOPE' }),
    });
    expect(dup.status).toBe('duplicate');
    expect(dup.messageId).toBe('MID');
    expect(guard.getStatus().minuteCount).toBe(1);
  });

  it('SENDING unknown returns before safety evaluation', async () => {
    const guard = safety({ burstLimit: 1 });
    guard.pause();
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'idem3.json'),
    });
    store.reserveSending({
      idempotencyKey: 'stuck',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'x' }),
    });
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'x',
      idempotencyKey: 'stuck',
      store,
      numberSafety: guard,
      sendFn: async () => ({ success: true, messageId: 'NO' }),
    });
    expect(result.code).toBe('OUTBOUND_RESULT_UNKNOWN');
    expect(result.code).not.toBe('OUTBOUND_NUMBER_SAFETY');
  });

  it('cooldown expires and allows send again', () => {
    const guard = safety({ burstLimit: 2, cooldownMs: 1000, burstWindowMs: 1500 });
    guard.recordSend({ phone: '1', message: 'a' });
    guard.recordSend({ phone: '1', message: 'a2' });
    expect(guard.check({ phone: '1', message: 'b' }).allowed).toBe(false);
    // Past cooldown and burst window so prior sends no longer count
    clock += 2000;
    expect(guard.check({ phone: '1', message: 'b' }).allowed).toBe(true);
    expect(guard.getStatus().state).not.toBe(STATES.COOLDOWN);
    expect(guard.getStatus().state).not.toBe(STATES.PAUSED);
  });

  it('repeated content triggers block', () => {
    const guard = safety({ repeatedContentLimit: 2, cooldownMs: 5000 });
    guard.recordSend({ phone: '201555111111', message: 'same' });
    guard.recordSend({ phone: '201555111111', message: 'same' });
    const blocked = guard.check({ phone: '201555111111', message: 'same' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('repeated_content');
  });

  it('successful send counts exposure once', async () => {
    const guard = safety({ perMinute: 100, burstLimit: 100 });
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'idem-ok.json'),
    });
    await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'ok',
      idempotencyKey: 'ok1',
      store,
      numberSafety: guard,
      sendFn: async () => ({ success: true, messageId: 'MID-OK' }),
    });
    expect(guard.getStatus().minuteCount).toBe(1);
  });

  it('ambiguous send counts exposure once', async () => {
    const guard = safety({ perMinute: 100, burstLimit: 100 });
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'idem-amb.json'),
    });
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'amb',
      idempotencyKey: 'amb1',
      store,
      numberSafety: guard,
      sendFn: async () => ({
        success: false,
        sendAttempted: true,
        outcomeUnknown: true,
        code: 'OUTBOUND_RESULT_UNKNOWN',
        error: 'timeout after send',
      }),
    });
    expect(result.code).toBe('OUTBOUND_RESULT_UNKNOWN');
    expect(guard.getStatus().minuteCount).toBe(1);
  });

  it('SENDING retry does not add exposure', async () => {
    const guard = safety({ perMinute: 100, burstLimit: 100 });
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'idem-sending.json'),
    });
    store.reserveSending({
      idempotencyKey: 'stuck2',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'x' }),
    });
    const before = guard.getStatus().minuteCount;
    await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'x',
      idempotencyKey: 'stuck2',
      store,
      numberSafety: guard,
      sendFn: async () => ({ success: true, messageId: 'NO' }),
    });
    expect(guard.getStatus().minuteCount).toBe(before);
  });

  it('number-safety rejection does not call transport or count', async () => {
    const guard = safety({ burstLimit: 1 });
    guard.recordAttempt({ phone: '201555111111', message: 'fill' });
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'idem-rej.json'),
    });
    let sendCalls = 0;
    const blocked = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'blocked',
      idempotencyKey: 'rej1',
      store,
      numberSafety: guard,
      sendFn: async () => {
        sendCalls += 1;
        return { success: true, messageId: 'NO' };
      },
    });
    expect(blocked.code).toBe('OUTBOUND_NUMBER_SAFETY');
    expect(sendCalls).toBe(0);
    expect(guard.getStatus().minuteCount).toBe(1);
  });

  it('sendAttempted:false from sendFn does not count exposure', async () => {
    const guard = safety({ perMinute: 100, burstLimit: 100 });
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'idem-presend.json'),
    });
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'pre',
      idempotencyKey: 'pre1',
      store,
      numberSafety: guard,
      sendFn: async () => ({
        success: false,
        sendAttempted: false,
        code: 'NOT_READY',
        error: 'not ready',
      }),
    });
    expect(result.success).toBe(false);
    expect(guard.getStatus().minuteCount).toBe(0);
    expect(store.get('pre1')).toBeNull();
  });
});
