import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedSourceReason } from '../src/sourcePolicy.js';

test('source gating checks actual chat before participant phone', () => {
  const cases = [
    ['12036300000000@g.us', 'group'],
    ['status@broadcast', 'broadcast'],
    ['1234@broadcast', 'broadcast'],
    ['1234@newsletter', 'newsletter'],
    ['1234@call', 'call'],
    ['201555123456@s.whatsapp.net', null],
    ['123456789@lid', null],
  ];
  for (const [remoteJid, expected] of cases) {
    const message = {
      key: { remoteJid, participantPn: '201555123456@s.whatsapp.net' },
    };
    assert.equal(blockedSourceReason(message), expected);
  }
});

test('alternative source and explicit broadcast marker reject private remaps', () => {
  assert.equal(blockedSourceReason({
    key: { remoteJid: '201555123456@s.whatsapp.net', remoteJidAlt: '12036300@g.us' },
  }), 'group');
  assert.equal(blockedSourceReason({
    key: { remoteJid: '201555123456@s.whatsapp.net' }, broadcast: true,
  }), 'broadcast');
});
