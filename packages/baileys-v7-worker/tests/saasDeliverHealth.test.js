import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaasDeliverer } from '../src/saasDeliver.js';

test('V7 successful inbound delivery clears a previous stale failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? { status: 401, json: async () => ({ code: 'AUTH_CONFIG' }) }
      : { status: 200, json: async () => ({ outcome: 'accepted' }) };
  };
  const delivery = createSaasDeliverer({
    accountKey: 'wa_health_test',
    ingestUrl: 'http://localhost/mock/inbound',
    runtimeToken: 'test-token',
    fetchImpl,
    logger: { log() {} },
  });
  assert.equal((await delivery.deliver({ providerMessageId: 'msg-1' })).ok, false);
  assert.equal(delivery.getStats().lastErrorCode, 'AUTH_CONFIG');
  assert.equal((await delivery.deliver({ providerMessageId: 'msg-2' })).ok, true);
  assert.equal(delivery.getStats().lastErrorCode, null);
});

test('disabled V7 delivery is not claimed as configured', async () => {
  const delivery = createSaasDeliverer({
    accountKey: 'wa_health_test',
    ingestUrl: 'http://localhost/mock/inbound',
    runtimeToken: 'test-token',
    enabled: false,
  });
  assert.equal(delivery.configured(), false);
});
