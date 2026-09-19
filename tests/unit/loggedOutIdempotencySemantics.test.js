'use strict';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  sendGenericWithIdempotency,
} = require('../../services/idempotency/genericIdempotentSend');
const {
  createMemoryDeliveryStore,
} = require('../../services/idempotency/memoryDeliveryStore');
const { STATUSES, CODES } = require('../../services/idempotency/constants');

const PHONE = '201555111111';
const MESSAGE = 'erp outbox body';
const KEY = 'sale:99:logged-out-retry';

describe('LOGGED_OUT idempotency semantics', () => {
  let store;
  let loggedOut;
  let connectCalls;
  let startCalls;
  let sendCalls;

  beforeEach(() => {
    store = createMemoryDeliveryStore();
    loggedOut = true;
    connectCalls = 0;
    startCalls = 0;
    sendCalls = 0;
  });

  function deps(overrides = {}) {
    return {
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      message: MESSAGE,
      metadata: {},
      store,
      ensureReady: async () => {
        if (loggedOut) {
          const err = new Error('WhatsApp session is logged out and must be linked again');
          err.code = 'LOGGED_OUT';
          throw err;
        }
        startCalls += 1;
      },
      isReady: async () => !loggedOut,
      sendAndWait: async () => {
        sendCalls += 1;
        if (loggedOut) {
          connectCalls += 1; // would be a bug if reached while loggedOut
          return {
            success: false,
            status: 'failed',
            code: 'LOGGED_OUT',
            error: 'WhatsApp session is logged out and must be linked again',
          };
        }
        return {
          success: true,
          status: 'sent',
          messageId: 'WA-AFTER-RELINK-1',
          phone: PHONE,
        };
      },
      ...overrides,
    };
  }

  it('1. LOGGED_OUT before send marks ledger RETRYABLE_FAILED', async () => {
    const result = await sendGenericWithIdempotency(deps());
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('LOGGED_OUT');
    expect(result.body.success).toBe(false);

    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.RETRYABLE_FAILED);
    expect(row.status).not.toBe(STATUSES.UNKNOWN);
  });

  it('2. same idempotency key after LOGGED_OUT can be claimed again', async () => {
    await sendGenericWithIdempotency(deps());
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.RETRYABLE_FAILED);

    // Second attempt while still logged out: claim retry, fail again as RETRYABLE_FAILED
    const second = await sendGenericWithIdempotency(deps());
    expect(second.body.code).toBe('LOGGED_OUT');
    const row2 = await store.getByKey(KEY);
    expect(row2.status).toBe(STATUSES.RETRYABLE_FAILED);
    expect(row2.attemptCount).toBeGreaterThanOrEqual(2);
  });

  it('3. while loggedOut, hard-stop path never reaches send/connect/start', async () => {
    // ensureReady throws LOGGED_OUT before sendAndWait — mirrors real getOrCreateDriver
    await sendGenericWithIdempotency(deps());
    await sendGenericWithIdempotency(deps());
    await sendGenericWithIdempotency(deps());
    expect(sendCalls).toBe(0);
    expect(connectCalls).toBe(0);
    expect(startCalls).toBe(0);
  });

  it('4. after simulated re-link, same key sends and becomes SENT', async () => {
    await sendGenericWithIdempotency(deps());
    expect((await store.getByKey(KEY)).status).toBe(STATUSES.RETRYABLE_FAILED);

    loggedOut = false;
    const result = await sendGenericWithIdempotency(deps());
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.messageId).toBe('WA-AFTER-RELINK-1');
    expect(sendCalls).toBe(1);
    expect(startCalls).toBe(1);

    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.SENT);
    expect(row.providerMessageId).toBe('WA-AFTER-RELINK-1');
  });

  it('5. UNKNOWN semantics unchanged for ambiguous post-send failures', async () => {
    loggedOut = false;
    const result = await sendGenericWithIdempotency(deps({
      ensureReady: async () => { startCalls += 1; },
      isReady: async () => true,
      sendAndWait: async () => ({
        success: false,
        status: 'unknown',
        code: 'OUTBOUND_RESULT_UNKNOWN',
        error: 'socket closed mid-send',
      }),
    }));
    expect(result.body.code).toBe(CODES.DELIVERY_STATUS_UNKNOWN);
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.UNKNOWN);

    // Same key must NOT become sendable again
    const retry = await sendGenericWithIdempotency(deps({
      ensureReady: async () => {},
      isReady: async () => true,
      sendAndWait: async () => {
        throw new Error('must not send again');
      },
    }));
    expect(retry.body.code).toBe(CODES.DELIVERY_STATUS_UNKNOWN);
  });

  it('LOGGED_OUT from sendAndWait result also marks RETRYABLE_FAILED', async () => {
    // Bypass ensureReady throw; sendAndWait returns LOGGED_OUT (pre-send definitive)
    const result = await sendGenericWithIdempotency(deps({
      ensureReady: async () => {},
      isReady: async () => true,
      sendAndWait: async () => ({
        success: false,
        status: 'failed',
        code: 'LOGGED_OUT',
        error: 'WhatsApp session is logged out and must be linked again',
      }),
    }));
    expect(result.body.code).toBe('LOGGED_OUT');
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.RETRYABLE_FAILED);

    loggedOut = false;
    const after = await sendGenericWithIdempotency(deps({
      ensureReady: async () => {},
      isReady: async () => true,
    }));
    expect(after.status).toBe(200);
    expect((await store.getByKey(KEY)).status).toBe(STATUSES.SENT);
  });
});
