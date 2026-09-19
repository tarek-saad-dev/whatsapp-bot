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
} = require('../../services/drvowa/outboundIdempotencyStore');
const {
  sendManagedWithIdempotency,
} = require('../../services/drvowa/managedOutboundSend');
const { createSendQueue } = require('../../services/sendQueue');
const { createWhatsAppAccountManager } = require('../../services/drvowa/accountManager');

describe('Phase 3B Part 2A managed outbound idempotency', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-out-idem-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. managed send requires idempotencyKey', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    const sendFn = viFn();
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: undefined,
      store,
      sendFn,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(sendFn.calls).toBe(0);
  });

  it('2/3/4. first key sends once; repeat returns same messageId without resend', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    const sendFn = viFn(async () => ({
      success: true,
      status: 'sent',
      messageId: 'WA-MSG-1',
    }));
    const first = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: 'key-1',
      store,
      sendFn,
    });
    expect(first.success).toBe(true);
    expect(first.status).toBe('sent');
    expect(first.messageId).toBe('WA-MSG-1');
    expect(sendFn.calls).toBe(1);

    const second = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: 'key-1',
      store,
      sendFn,
    });
    expect(second.success).toBe(true);
    expect(second.status).toBe('duplicate');
    expect(second.messageId).toBe('WA-MSG-1');
    expect(sendFn.calls).toBe(1);
  });

  it('5. concurrent duplicate requests call send once via queue', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    let releases = 0;
    let resolveGate;
    const gate = new Promise((r) => { resolveGate = r; });
    const sendFn = viFn(async () => {
      await gate;
      releases += 1;
      return { success: true, status: 'sent', messageId: 'WA-ONCE' };
    });
    const queue = createSendQueue({ concurrency: 1 });

    const p1 = queue.enqueue(() => sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: 'key-conc',
      store,
      sendFn,
    }));
    const p2 = queue.enqueue(() => sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: 'key-conc',
      store,
      sendFn,
    }));
    resolveGate();
    const [a, b] = await Promise.all([p1, p2]);
    expect(sendFn.calls).toBe(1);
    expect(releases).toBe(1);
    expect([a.messageId, b.messageId].every((id) => id === 'WA-ONCE')).toBe(true);
    expect([a.status, b.status].sort()).toEqual(['duplicate', 'sent']);
  });

  it('6. same key incompatible destination => conflict', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    const sendFn = viFn(async () => ({
      success: true,
      status: 'sent',
      messageId: 'WA-MSG-2',
    }));
    await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: 'key-conflict',
      store,
      sendFn,
    });
    const conflict = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555999999',
      message: 'hi',
      idempotencyKey: 'key-conflict',
      store,
      sendFn,
    });
    expect(conflict.success).toBe(false);
    expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(sendFn.calls).toBe(1);
  });

  it('7/8. idempotency store survives restart and returns original messageId', async () => {
    const filePath = path.join(tmpDir, 'outbound-idempotency.json');
    const store1 = createOutboundIdempotencyStore({ filePath });
    const sendFn = viFn(async () => ({
      success: true,
      status: 'sent',
      messageId: 'WA-PERSIST',
    }));
    await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'persist',
      idempotencyKey: 'key-persist',
      store: store1,
      sendFn,
    });

    const store2 = createOutboundIdempotencyStore({ filePath });
    const sendFn2 = viFn(async () => ({
      success: true,
      status: 'sent',
      messageId: 'SHOULD-NOT',
    }));
    const replay = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'persist',
      idempotencyKey: 'key-persist',
      store: store2,
      sendFn: sendFn2,
    });
    expect(replay.status).toBe('duplicate');
    expect(replay.messageId).toBe('WA-PERSIST');
    expect(sendFn2.calls).toBe(0);
  });

  it('9/10. SENDING after restart returns OUTBOUND_RESULT_UNKNOWN and never auto-resends', async () => {
    const filePath = path.join(tmpDir, 'outbound-idempotency.json');
    const store1 = createOutboundIdempotencyStore({ filePath });
    store1.reserveSending({
      idempotencyKey: 'key-ambig',
      phone: '201555111111',
      payloadHash: hashPayload({ phone: '201555111111', message: 'x' }),
    });

    const store2 = createOutboundIdempotencyStore({ filePath });
    const sendFn = viFn(async () => ({
      success: true,
      status: 'sent',
      messageId: 'SHOULD-NOT',
    }));
    const result = await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'x',
      idempotencyKey: 'key-ambig',
      store: store2,
      sendFn,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.code).toBe('OUTBOUND_RESULT_UNKNOWN');
    expect(sendFn.calls).toBe(0);
    expect(store2.get('key-ambig').state).toBe(STATES.SENDING);
  });

  it('11. account A key cannot affect account B', async () => {
    const storeA = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'a', 'outbound-idempotency.json'),
    });
    const storeB = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'b', 'outbound-idempotency.json'),
    });
    const sendA = viFn(async () => ({ success: true, messageId: 'A1' }));
    const sendB = viFn(async () => ({ success: true, messageId: 'B1' }));
    await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: 'shared-key',
      store: storeA,
      sendFn: sendA,
    });
    const b = await sendManagedWithIdempotency({
      accountKey: 'wa_b',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: 'shared-key',
      store: storeB,
      sendFn: sendB,
    });
    expect(b.status).toBe('sent');
    expect(b.messageId).toBe('B1');
    expect(sendA.calls).toBe(1);
    expect(sendB.calls).toBe(1);
  });

  it('12. retention remains bounded', () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
      maxEntries: 5,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    for (let i = 0; i < 12; i += 1) {
      store.reserveSending({
        idempotencyKey: `k-${i}`,
        phone: '201555111111',
        payloadHash: `h${i}`,
      });
      store.markSent({ idempotencyKey: `k-${i}`, providerMessageId: `m${i}` });
    }
    expect(store.size()).toBeLessThanOrEqual(5);
  });

  it('13. API outbound providerMessageId correlated with DRVOWA_API', async () => {
    const store = createOutboundIdempotencyStore({
      filePath: path.join(tmpDir, 'outbound-idempotency.json'),
    });
    await sendManagedWithIdempotency({
      accountKey: 'wa_a',
      phone: '201555111111',
      message: 'hi',
      idempotencyKey: 'key-corr',
      store,
      sendFn: async () => ({ success: true, messageId: 'CORR-1' }),
    });
    expect(store.isApiOrigin('CORR-1')).toBe(true);
    expect(store.isApiOrigin('UNKNOWN')).toBe(false);
  });

  it('manager send path requires key', async () => {
    const manager = createWhatsAppAccountManager({
      enabled: () => true,
      authBaseDir: path.join(tmpDir, 'accounts'),
      createProvider: ({ accountKey }) => ({
        accountKey,
        getStatus: () => ({ state: 'READY', ready: true }),
        async start() {
          return this.getStatus();
        },
        send: async (phone, message, opts) => sendManagedWithIdempotency({
          accountKey,
          phone,
          message,
          idempotencyKey: opts && opts.idempotencyKey,
          store: createOutboundIdempotencyStore({
            filePath: path.join(tmpDir, accountKey, 'outbound-idempotency.json'),
          }),
          sendFn: async () => ({ success: true, messageId: 'M1' }),
        }),
      }),
    });
    await manager.start('wa_mgr');
    const missing = await manager.send('wa_mgr', { phone: '201555', message: 'x' });
    expect(missing.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

function viFn(impl) {
  const fn = async (...args) => {
    fn.calls += 1;
    fn.args.push(args);
    if (impl) return impl(...args);
    return undefined;
  };
  fn.calls = 0;
  fn.args = [];
  return fn;
}
