import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildV7OutboundObservation } from '../src/outboundObserve.js';

describe('v7 outbound observation (fromMe)', () => {
  it('builds observation for fromMe PN destination', async () => {
    const built = await buildV7OutboundObservation({
      key: {
        fromMe: true,
        id: 'MID1',
        remoteJid: '201557994946@s.whatsapp.net',
      },
      message: { conversation: 'hello staff' },
      messageTimestamp: 1700000000,
    });
    assert.equal(built.ok, true);
    assert.equal(built.observation.providerMessageId, 'MID1');
    assert.equal(built.observation.phone, '201557994946');
    assert.equal(built.observation.text, 'hello staff');
  });

  it('does not treat fromMe as inbound (rejects not_fromMe for customer msgs)', async () => {
    const built = await buildV7OutboundObservation({
      key: { fromMe: false, id: 'X', remoteJid: '201557994946@s.whatsapp.net' },
      message: { conversation: 'hi' },
    });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'not_fromMe');
  });

  it('ignores group fromMe', async () => {
    const built = await buildV7OutboundObservation({
      key: { fromMe: true, id: 'G1', remoteJid: '120363@g.us' },
      message: { conversation: 'group' },
    });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'group');
  });

  it('ignores status broadcast', async () => {
    const built = await buildV7OutboundObservation({
      key: { fromMe: true, id: 'S1', remoteJid: 'status@broadcast' },
      message: { conversation: 'status' },
    });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'status_or_broadcast');
  });

  it('resolves LID destination via resolveLidPn', async () => {
    const built = await buildV7OutboundObservation({
      key: {
        fromMe: true,
        id: 'L1',
        remoteJid: '12345678901234@lid',
      },
      message: { extendedTextMessage: { text: 'manual reply' } },
    }, {
      resolveLidPn: async () => '201557994946@s.whatsapp.net',
    });
    assert.equal(built.ok, true);
    assert.equal(built.observation.phone, '201557994946');
  });

  it('uses remoteJidAlt for LID chats', async () => {
    const built = await buildV7OutboundObservation({
      key: {
        fromMe: true,
        id: 'L2',
        remoteJid: '999@lid',
        remoteJidAlt: '201557994946@s.whatsapp.net',
      },
      message: { conversation: 'alt' },
    });
    assert.equal(built.ok, true);
    assert.equal(built.observation.phone, '201557994946');
  });

  it('rejects unresolved LID destination as UNRESOLVED-equivalent skip', async () => {
    const built = await buildV7OutboundObservation({
      key: { fromMe: true, id: 'L3', remoteJid: '111@lid' },
      message: { conversation: 'x' },
    }, { resolveLidPn: async () => null });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'unresolved_destination');
  });

  it('rejects self destination', async () => {
    const built = await buildV7OutboundObservation({
      key: {
        fromMe: true,
        id: 'SELF',
        remoteJid: '201012126899@s.whatsapp.net',
      },
      message: { conversation: 'to self' },
    }, { ownDigits: '201012126899' });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'self_destination');
  });
});
