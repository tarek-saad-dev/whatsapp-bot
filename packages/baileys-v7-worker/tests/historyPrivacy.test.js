import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryPrivacyPolicy, allowsMirrorEvent, allowsMediaEvent } from '../src/historyPrivacy.js';

test('account scoped consent expires and fails closed, without blocking live messages', async () => {
  let clock = 1;
  let mode = true;
  const policy = createHistoryPrivacyPolicy({ accountKey: 'account-1', token: 'test',
    baseUrl: 'http://localhost', now: () => clock, ttlMs: 10,
    fetchFn: async (url, options) => {
      assert.equal(url, 'http://localhost/api/runtime/whatsapp/privacy');
      assert.deepEqual(JSON.parse(options.body), { accountKey: 'account-1' });
      if (mode === null) throw new Error('network');
      return { ok: true, json: async () => ({ historyImportEnabled: mode, privateContactPhones: [] }) };
    },
  });
  assert.equal(policy.current(), 'unknown');
  assert.equal(await policy.get(), 'allow');
  clock += 11;
  assert.equal(policy.current(), 'unknown');
  mode = false;
  assert.equal(await policy.get(), 'fresh');
  assert.equal(allowsMirrorEvent({ kind: 'message', historical: true }, policy.current()), false);
  assert.equal(allowsMirrorEvent({ kind: 'message', historical: false }, policy.current()), true);
  mode = null; clock += 11;
  assert.equal(await policy.get(), 'unknown');
  assert.equal(allowsMirrorEvent({ kind: 'chat' }, policy.current()), false);
});

test('fresh or unknown policy filters pre-existing mirror and media spools', () => {
  for (const mode of ['fresh', 'unknown']) {
    for (const kind of ['chat', 'label', 'labelAssociation']) assert.equal(allowsMirrorEvent({ kind }, mode), false);
    assert.equal(allowsMediaEvent({ historical: true }, mode), false);
    assert.equal(allowsMediaEvent({}, mode), false);
    assert.equal(allowsMediaEvent({ historical: false }, mode), true);
    assert.equal(allowsMirrorEvent({ kind: 'message' }, mode), false);
  }
  assert.equal(allowsMediaEvent({}, 'allow'), true);
});

test('global disabled switch cannot be overridden by server consent', async () => {
  const policy = createHistoryPrivacyPolicy({ enabled: false, accountKey: 'test', token: 'test',
    fetchFn: async () => ({ ok: true, json: async () => ({ historyImportEnabled: true, privateContactPhones: [] }) }) });
  assert.equal(await policy.get(), 'fresh');
});

test('private contact policy blocks unresolved and excluded identities, expires fail closed', async () => {
  let clock = 1;
  const policy = createHistoryPrivacyPolicy({ accountKey: 'a', token: 'test', baseUrl: 'http://localhost',
    now: () => clock, ttlMs: 10,
    fetchFn: async () => ({ ok: true, json: async () => ({ historyImportEnabled: true, privateContactPhones: ['201001234567'] }) }),
  });
  assert.equal(policy.contactAllowed('201001234568'), false);
  await policy.get();
  assert.equal(policy.contactAllowed('201001234567@s.whatsapp.net'), false);
  assert.equal(policy.contactAllowed('123456789@lid'), false);
  assert.equal(policy.contactAllowed('201001234568@s.whatsapp.net'), true);
  assert.equal(policy.metadataAllowed(), false);
  clock += 11;
  assert.equal(policy.contactAllowed('201001234568'), false);
});
