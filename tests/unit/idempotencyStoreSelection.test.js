'use strict';

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  shouldUseMemoryStore,
  resetDeliveryStore,
} = require('../../services/idempotency/deliveryStore');

describe('gateway idempotency store selection', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env.GATEWAY_IDEMPOTENCY_STORE = original.GATEWAY_IDEMPOTENCY_STORE;
    process.env.DB_SERVER = original.DB_SERVER;
    process.env.VITEST = original.VITEST;
    resetDeliveryStore();
  });

  it('uses memory when GATEWAY_IDEMPOTENCY_STORE=memory', () => {
    process.env.GATEWAY_IDEMPOTENCY_STORE = 'memory';
    process.env.DB_SERVER = '127.0.0.1';
    process.env.VITEST = 'false';
    expect(shouldUseMemoryStore()).toBe(true);
  });

  it('uses sql when GATEWAY_IDEMPOTENCY_STORE=sql even under vitest', () => {
    process.env.GATEWAY_IDEMPOTENCY_STORE = 'sql';
    process.env.DB_SERVER = '127.0.0.1';
    expect(shouldUseMemoryStore()).toBe(false);
  });

  it('uses sql when DB_SERVER is real and store mode unset (outside vitest)', () => {
    delete process.env.GATEWAY_IDEMPOTENCY_STORE;
    process.env.DB_SERVER = '127.0.0.1';
    process.env.VITEST = 'false';
    expect(shouldUseMemoryStore()).toBe(false);
  });

  it('never treats placeholder DB_SERVER as sql', () => {
    delete process.env.GATEWAY_IDEMPOTENCY_STORE;
    process.env.DB_SERVER = 'YOUR_PC_NAME_OR_IP';
    process.env.VITEST = 'false';
    expect(shouldUseMemoryStore()).toBe(true);
  });
});
