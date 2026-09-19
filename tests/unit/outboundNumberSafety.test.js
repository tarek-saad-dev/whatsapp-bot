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
  MINUTE_MS,
  HOUR_MS,
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

  describe('time windows (fake clock)', () => {
    it('A. after 2 minutes: minute=0 hour=1 day=1', () => {
      const guard = safety({ perMinute: 100, perHour: 100, perDay: 100, burstLimit: 100 });
      guard.recordAttempt({ phone: '201555111111', message: 'one' });
      clock += 2 * MINUTE_MS;
      const s = guard.getStatus();
      expect(s.minuteCount).toBe(0);
      expect(s.hourCount).toBe(1);
      expect(s.dayCount).toBe(1);
    });

    it('B. after 2 hours: minute=0 hour=0 day=1', () => {
      const guard = safety({ perMinute: 100, perHour: 100, perDay: 100, burstLimit: 100 });
      guard.recordAttempt({ phone: '201555111111', message: 'one' });
      clock += 2 * HOUR_MS;
      const s = guard.getStatus();
      expect(s.minuteCount).toBe(0);
      expect(s.hourCount).toBe(0);
      expect(s.dayCount).toBe(1);
    });

    it('C. after >24 hours: day=0', () => {
      const guard = safety({ perMinute: 100, perHour: 100, perDay: 100, burstLimit: 100 });
      guard.recordAttempt({ phone: '201555111111', message: 'one' });
      clock += 25 * HOUR_MS;
      const s = guard.getStatus();
      expect(s.minuteCount).toBe(0);
      expect(s.hourCount).toBe(0);
      expect(s.dayCount).toBe(0);
    });

    it('D. perHour really blocks across minute boundaries', () => {
      const guard = safety({
        perMinute: 100,
        perHour: 2,
        perDay: 100,
        burstLimit: 100,
        cooldownMs: 60_000,
      });

      guard.recordAttempt({ phone: '201555000001', message: 'h1' });
      clock += 2 * MINUTE_MS;
      guard.recordAttempt({ phone: '201555000002', message: 'h2' });
      clock += 2 * MINUTE_MS;
      expect(guard.getStatus().minuteCount).toBe(0);
      expect(guard.getStatus().hourCount).toBe(2);
      const blocked = guard.check({ phone: '201555000003', message: 'h3' });
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toBe('rate_limit');
    });

    it('E. perDay really blocks across hours inside 24h', () => {
      const guard = safety({
        perMinute: 100,
        perHour: 100,
        perDay: 2,
        burstLimit: 100,
        cooldownMs: 60_000,
      });
      guard.recordAttempt({ phone: '201555000001', message: 'd1' });
      clock += 3 * HOUR_MS;
      guard.recordAttempt({ phone: '201555000002', message: 'd2' });
      clock += 3 * HOUR_MS;
      expect(guard.getStatus().hourCount).toBe(0);
      expect(guard.getStatus().dayCount).toBe(2);
      const blocked = guard.check({ phone: '201555000003', message: 'd3' });
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toBe('rate_limit');
    });
  });

  describe('repeated content (content-only fingerprint)', () => {
    it('F. same text across destinations hits repeated_content', () => {
      const guard = safety({
        repeatedContentLimit: 2,
        perMinute: 100,
        perHour: 100,
        perDay: 100,
        burstLimit: 100,
        fanOutUniquePerHour: 100,
        cautionCooldownMs: 5000,
      });
      guard.recordAttempt({ phone: '201555000001', message: 'promo text' });
      guard.recordAttempt({ phone: '201555000002', message: 'promo text' });
      const blocked = guard.check({ phone: '201555000003', message: 'promo text' });
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toBe('repeated_content');
    });

    it('G. different text to same phones does not trigger repeated_content', () => {
      const guard = safety({
        repeatedContentLimit: 2,
        perMinute: 100,
        perHour: 100,
        perDay: 100,
        burstLimit: 100,
        fanOutUniquePerHour: 100,
      });
      guard.recordAttempt({ phone: '201555000001', message: 'alpha' });
      guard.recordAttempt({ phone: '201555000001', message: 'beta' });
      const ok = guard.check({ phone: '201555000001', message: 'gamma' });
      expect(ok.allowed).toBe(true);
      expect(ok.reason).toBe('ok');
    });

    it('H. stale content fingerprints cleaned after repeatedContentWindowMs', () => {
      const windowMs = 10_000;
      const guard = safety({
        repeatedContentWindowMs: windowMs,
        repeatedContentLimit: 50,
        perMinute: 1000,
        perHour: 1000,
        perDay: 1000,
        burstLimit: 1000,
        fanOutUniquePerHour: 1000,
      });
      for (let i = 0; i < 8; i += 1) {
        guard.recordAttempt({ phone: `20155500000${i}`, message: `unique-content-${i}` });
      }
      expect(guard.getInternalStats().contentFingerprintCount).toBe(8);
      expect(guard.getStatus()).not.toHaveProperty('contentFingerprintCount');
      const statusKeys = Object.keys(guard.getStatus());
      expect(statusKeys).not.toContain('hashes');
      expect(statusKeys).not.toContain('contentHashes');

      clock += windowMs + 1;
      guard.check({ phone: '201555999999', message: 'probe' });
      expect(guard.getInternalStats().contentFingerprintCount).toBe(0);

      // Destination map is retained for the hour fan-out window, then pruned.
      clock += HOUR_MS;
      guard.check({ phone: '201555999998', message: 'probe2' });
      expect(guard.getInternalStats().destinationEntryCount).toBe(0);
    });
  });

  it('getStatus never exposes hashes or plaintext', () => {
    const guard = safety();
    guard.recordAttempt({ phone: '201555111111', message: 'secret body' });
    const status = guard.getStatus();
    const blob = JSON.stringify(status);
    expect(blob).not.toMatch(/secret body/);
    expect(blob).not.toMatch(/201555111111/);
    expect(status).not.toHaveProperty('contentFingerprintCount');
  });
});
