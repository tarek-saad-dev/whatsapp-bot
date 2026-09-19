'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  createOutboundIdempotencyStore,
  hashPayload,
  STATES,
  CAPACITY_CODE,
} = require('../../services/drvowa/outboundIdempotencyStore');
const {
  sendManagedWithIdempotency,
} = require('../../services/drvowa/managedOutboundSend');

describe('outbound idempotency SENDING prune safety', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-prune-safe-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFixture(filePath, entries) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    }, null, 2), 'utf8');
  }

  function oldIso(daysAgo) {
    return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  }

  it('A. retention prunes old SENT but preserves old SENDING', () => {
    const filePath = path.join(tmpDir, 'outbound-idempotency.json');
    writeFixture(filePath, [
      {
        idempotencyKey: 'old-sent',
        state: STATES.SENT,
        providerMessageId: 'PID-OLD-SENT',
        phone: '201555111111',
        payloadHash: 'h1',
        origin: 'DRVOWA_API',
        createdAt: oldIso(10),
        updatedAt: oldIso(10),
      },
      {
        idempotencyKey: 'old-sending',
        state: STATES.SENDING,
        providerMessageId: null,
        phone: '201555111111',
        payloadHash: 'h2',
        origin: 'DRVOWA_API',
        createdAt: oldIso(10),
        updatedAt: oldIso(10),
      },
    ]);

    const store = createOutboundIdempotencyStore({
      filePath,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 2000,
    });

    expect(store.get('old-sent')).toBeNull();
    expect(store.get('old-sending')).not.toBeNull();
    expect(store.get('old-sending').state).toBe(STATES.SENDING);
    expect(store.isApiOrigin('PID-OLD-SENT')).toBe(false);
  });

  it('B. maxEntries full of SENDING rejects new key before sendFn', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
      maxEntries: 3,
    });
    store.reserveSending({ idempotencyKey: 'A', phone: '201555111111', payloadHash: 'ha' });
    store.reserveSending({ idempotencyKey: 'B', phone: '201555111111', payloadHash: 'hb' });
    store.reserveSending({ idempotencyKey: 'C', phone: '201555111111', payloadHash: 'hc' });

    let sendCalls = 0;
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'new',
      idempotencyKey: 'D',
      store,
      sendFn: async () => {
        sendCalls += 1;
        return { success: true, messageId: 'SHOULD-NOT' };
      },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.code).toBe(CAPACITY_CODE);
    expect(result.code).not.toBe('OUTBOUND_RESULT_UNKNOWN');
    expect(result.sendAttempted).toBe(false);
    expect(result.outcomeUnknown).toBe(false);
    expect(result.httpStatus).toBe(503);
    expect(sendCalls).toBe(0);
    expect(store.get('A').state).toBe(STATES.SENDING);
    expect(store.get('B').state).toBe(STATES.SENDING);
    expect(store.get('C').state).toBe(STATES.SENDING);
    expect(store.get('D')).toBeNull();
    expect(store.getStats().saturated).toBe(true);
  });

  it('C. mixed store can evict SENT but preserve SENDING for new reserve', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
      maxEntries: 3,
    });
    store.reserveSending({ idempotencyKey: 'A', phone: '201555111111', payloadHash: 'ha' });
    store.reserveSending({ idempotencyKey: 'B', phone: '201555111111', payloadHash: 'hb' });
    store.markSent({ idempotencyKey: 'B', providerMessageId: 'PID-B' });
    store.reserveSending({ idempotencyKey: 'C', phone: '201555111111', payloadHash: 'hc' });
    store.markSent({ idempotencyKey: 'C', providerMessageId: 'PID-C' });

    expect(store.size()).toBe(3);
    expect(store.get('A').state).toBe(STATES.SENDING);

    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555222222',
      message: 'd-msg',
      idempotencyKey: 'D',
      store,
      sendFn: async () => ({ success: true, messageId: 'PID-D' }),
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('PID-D');
    expect(store.get('A').state).toBe(STATES.SENDING);
    expect(store.get('D').state).toBe(STATES.SENT);
    expect(store.size()).toBeLessThanOrEqual(3);
  });

  it('D. capacity eviction skips SENDING even if much older than SENT', () => {
    const filePath = path.join(tmpDir, 'outbound-idempotency.json');
    writeFixture(filePath, [
      {
        idempotencyKey: 'ancient-sending',
        state: STATES.SENDING,
        providerMessageId: null,
        phone: '201555111111',
        payloadHash: 'ha',
        origin: 'DRVOWA_API',
        createdAt: oldIso(30),
        updatedAt: oldIso(30),
      },
      {
        idempotencyKey: 'newer-sent',
        state: STATES.SENT,
        providerMessageId: 'PID-NEWER',
        phone: '201555111111',
        payloadHash: 'hb',
        origin: 'DRVOWA_API',
        createdAt: oldIso(1),
        updatedAt: oldIso(1),
      },
      {
        idempotencyKey: 'newest-sent',
        state: STATES.SENT,
        providerMessageId: 'PID-NEWEST',
        phone: '201555111111',
        payloadHash: 'hc',
        origin: 'DRVOWA_API',
        createdAt: oldIso(0.5),
        updatedAt: oldIso(0.5),
      },
    ]);

    const store = createOutboundIdempotencyStore({
      filePath,
      maxEntries: 2,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });

    // Load prune: size 3 > max 2 → evict oldest SENT only
    expect(store.get('ancient-sending')).not.toBeNull();
    expect(store.get('ancient-sending').state).toBe(STATES.SENDING);
    expect(store.get('newer-sent')).toBeNull();
    expect(store.isApiOrigin('PID-NEWER')).toBe(false);
    expect(store.get('newest-sent')).not.toBeNull();
    expect(store.size()).toBe(2);
  });

  it('E. restart preserves old SENDING; same key is UNKNOWN without send', async () => {
    const filePath = path.join(tmpDir, 'outbound-idempotency.json');
    writeFixture(filePath, [
      {
        idempotencyKey: 'stuck',
        state: STATES.SENDING,
        providerMessageId: null,
        phone: '201555111111',
        payloadHash: hashPayload({ phone: '201555111111', message: 'hi' }),
        origin: 'DRVOWA_API',
        createdAt: oldIso(10),
        updatedAt: oldIso(10),
      },
    ]);

    const store = createOutboundIdempotencyStore({
      filePath,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(store.get('stuck').state).toBe(STATES.SENDING);

    let sendCalls = 0;
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: 'stuck',
      store,
      sendFn: async () => {
        sendCalls += 1;
        return { success: true, messageId: 'NOPE' };
      },
    });
    expect(result.code).toBe('OUTBOUND_RESULT_UNKNOWN');
    expect(sendCalls).toBe(0);
  });

  it('F. saturated load keeps all SENDING over maxEntries; new key fails capacity', async () => {
    const filePath = path.join(tmpDir, 'outbound-idempotency.json');
    writeFixture(filePath, ['A', 'B', 'C', 'D'].map((k, i) => ({
      idempotencyKey: k,
      state: STATES.SENDING,
      providerMessageId: null,
      phone: '201555111111',
      payloadHash: `h${i}`,
      origin: 'DRVOWA_API',
      createdAt: oldIso(2),
      updatedAt: oldIso(2),
    })));

    const store = createOutboundIdempotencyStore({
      filePath,
      maxEntries: 3,
    });
    expect(store.size()).toBe(4);
    expect(store.get('A')).not.toBeNull();
    expect(store.get('B')).not.toBeNull();
    expect(store.get('C')).not.toBeNull();
    expect(store.get('D')).not.toBeNull();

    let sendCalls = 0;
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'e',
      idempotencyKey: 'E',
      store,
      sendFn: async () => {
        sendCalls += 1;
        return { success: true, messageId: 'X' };
      },
    });
    expect(result.code).toBe(CAPACITY_CODE);
    expect(sendCalls).toBe(0);
    expect(store.size()).toBe(4);
  });

  it('G. reconcile SENDING → SENT recovers capacity for new reservation', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
      maxEntries: 2,
    });
    const phone = '201555111111';
    const message = 'recon me';
    const payloadHash = hashPayload({ phone, message });
    store.reserveSending({ idempotencyKey: 'A', phone, payloadHash });
    store.reserveSending({ idempotencyKey: 'B', phone, payloadHash: 'hb' });
    expect(store.getStats().saturated).toBe(true);

    const recon = store.reconcileSendingFromObservation({
      phone,
      text: message,
      providerMessageId: 'PID-RECON-A',
    });
    expect(recon.reconciled).toBe(true);
    expect(store.get('A').state).toBe(STATES.SENT);
    expect(store.isApiOrigin('PID-RECON-A')).toBe(true);

    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555333333',
      message: 'new after recon',
      idempotencyKey: 'C',
      store,
      sendFn: async () => ({ success: true, messageId: 'PID-C' }),
    });
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('PID-C');
  });

  it('H. saturated store still replays existing SENT without new capacity', async () => {
    const filePath = path.join(tmpDir, 'replay-sat.json');
    writeFixture(filePath, [
      {
        idempotencyKey: 'sent-key',
        state: STATES.SENT,
        providerMessageId: 'PID-SENT',
        phone: '201555111111',
        payloadHash: hashPayload({ phone: '201555111111', message: 'hello' }),
        origin: 'DRVOWA_API',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        idempotencyKey: 'S1',
        state: STATES.SENDING,
        providerMessageId: null,
        phone: '201555111111',
        payloadHash: 'h1',
        origin: 'DRVOWA_API',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        idempotencyKey: 'S2',
        state: STATES.SENDING,
        providerMessageId: null,
        phone: '201555111111',
        payloadHash: 'h2',
        origin: 'DRVOWA_API',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const satStore = createOutboundIdempotencyStore({ filePath, maxEntries: 3 });
    expect(satStore.size()).toBe(3);
    expect(satStore.get('sent-key').state).toBe(STATES.SENT);

    // New key would need capacity (would evict SENT or fail) — replay must not need a slot.
    let sendCalls = 0;
    const replay = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hello',
      idempotencyKey: 'sent-key',
      store: satStore,
      sendFn: async () => {
        sendCalls += 1;
        return { success: true, messageId: 'NEW' };
      },
    });
    expect(replay.status).toBe('duplicate');
    expect(replay.messageId).toBe('PID-SENT');
    expect(sendCalls).toBe(0);
    expect(satStore.size()).toBe(3);
  });

  it('I. definitive pre-send failure clears SENDING and frees slot', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
      maxEntries: 1,
    });
    const first = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'fail',
      idempotencyKey: 'k-fail',
      store,
      sendFn: async () => ({
        success: false,
        sendAttempted: false,
        code: 'NOT_READY',
        error: 'not ready',
      }),
    });
    expect(first.success).toBe(false);
    expect(store.get('k-fail')).toBeNull();

    const second = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'ok',
      idempotencyKey: 'k-ok',
      store,
      sendFn: async () => ({ success: true, messageId: 'PID-OK' }),
    });
    expect(second.success).toBe(true);
    expect(second.messageId).toBe('PID-OK');
  });

  it('J. ambiguous send preserves SENDING and never resends', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    let sendCalls = 0;
    const first = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'amb',
      idempotencyKey: 'k-amb',
      store,
      sendFn: async () => {
        sendCalls += 1;
        return {
          success: false,
          sendAttempted: true,
          outcomeUnknown: true,
          code: 'OUTBOUND_RESULT_UNKNOWN',
        };
      },
    });
    expect(first.code).toBe('OUTBOUND_RESULT_UNKNOWN');
    expect(store.get('k-amb').state).toBe(STATES.SENDING);

    const second = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'amb',
      idempotencyKey: 'k-amb',
      store,
      sendFn: async () => {
        sendCalls += 1;
        return { success: true, messageId: 'NOPE' };
      },
    });
    expect(second.code).toBe('OUTBOUND_RESULT_UNKNOWN');
    expect(sendCalls).toBe(1);
  });

  it('K. provider index: retained SENT true; pruned SENT false; not corrupted', () => {
    const filePath = path.join(tmpDir, 'outbound-idempotency.json');
    writeFixture(filePath, [
      {
        idempotencyKey: 'keep',
        state: STATES.SENT,
        providerMessageId: 'PID-KEEP',
        phone: '201555111111',
        payloadHash: 'hk',
        origin: 'DRVOWA_API',
        createdAt: oldIso(1),
        updatedAt: oldIso(1),
      },
      {
        idempotencyKey: 'drop',
        state: STATES.SENT,
        providerMessageId: 'PID-DROP',
        phone: '201555111111',
        payloadHash: 'hd',
        origin: 'DRVOWA_API',
        createdAt: oldIso(10),
        updatedAt: oldIso(10),
      },
      {
        idempotencyKey: 'sending',
        state: STATES.SENDING,
        providerMessageId: null,
        phone: '201555111111',
        payloadHash: 'hs',
        origin: 'DRVOWA_API',
        createdAt: oldIso(10),
        updatedAt: oldIso(10),
      },
    ]);

    const store = createOutboundIdempotencyStore({
      filePath,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 2000,
    });

    expect(store.isApiOrigin('PID-KEEP')).toBe(true);
    expect(store.isApiOrigin('PID-DROP')).toBe(false);
    expect(store.get('sending').state).toBe(STATES.SENDING);
    expect(store.getByProviderMessageId('PID-KEEP').idempotencyKey).toBe('keep');
  });
});