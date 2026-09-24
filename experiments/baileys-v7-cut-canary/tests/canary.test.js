'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

describe('v7 canary package', () => {
  it('loads pinned baileys version', async () => {
    const req = createRequire(path.join(root, 'package.json'));
    const pkg = req('./package.json');
    assert.equal(pkg.dependencies['@whiskeysockets/baileys'], '7.0.0-rc14');
    assert.equal(pkg.type, 'module');
    // caret/tilde forbidden
    assert.equal(pkg.dependencies['@whiskeysockets/baileys'].includes('^'), false);
    assert.equal(pkg.dependencies['@whiskeysockets/baileys'].includes('~'), false);
  });

  it('v7 module loads', async () => {
    const baileys = await import('@whiskeysockets/baileys');
    assert.equal(typeof baileys.default, 'function');
    assert.equal(typeof baileys.useMultiFileAuthState, 'function');
  });
});

describe('safe logger', () => {
  it('redacts and classifies plaintext', async () => {
    const { summarizeInbound, assertSafeLogShape, logInboundSafe, classifyRemote } = await import(
      pathToFileURL(path.join(root, 'src/safeLog.js')).href
    );
    assert.equal(classifyRemote('123@lid'), 'LID');
    assert.equal(classifyRemote('2010@s.whatsapp.net'), 'PN');
    assert.equal(classifyRemote('x@g.us'), 'GROUP');

    const summary = summarizeInbound({
      key: { id: 'ABC', remoteJid: '999@lid', fromMe: false, senderPn: '201555@s.whatsapp.net' },
      message: { conversation: 'hello world' },
    });
    assert.equal(summary.plaintextPresent, 'YES');
    assert.equal(summary.textLength, 11);
    assert.equal(summary.decryptOutcome, 'plaintext_ok');
    assert.equal(summary.remoteType, 'LID');
    assert.equal(summary.senderPnPresent, 'YES');
    // log shape must not include jid
    const logged = logInboundSafe(summary, 'notify');
    assertSafeLogShape(logged);
  });

  it('classifies CIPHERTEXT stub', async () => {
    const { summarizeInbound } = await import(pathToFileURL(path.join(root, 'src/safeLog.js')).href);
    const summary = summarizeInbound({
      key: { id: 'CID', remoteJid: '1@lid', fromMe: false },
      messageStubType: 2,
      messageStubParameters: ['Message absent from node'],
      message: undefined,
    });
    assert.equal(summary.stubType, 2);
    assert.equal(summary.plaintextPresent, 'NO');
    assert.equal(summary.decryptOutcome, 'ciphertext_or_stub');
  });

  it('ignores fromMe and groups', async () => {
    const { summarizeInbound } = await import(pathToFileURL(path.join(root, 'src/safeLog.js')).href);
    const fromMe = summarizeInbound({
      key: { id: '1', remoteJid: '1@s.whatsapp.net', fromMe: true },
      message: { conversation: 'x' },
    });
    assert.equal(fromMe.decryptOutcome, 'ignored_fromMe');
    const group = summarizeInbound({
      key: { id: '2', remoteJid: 'g@g.us', fromMe: false },
      message: { conversation: 'x' },
    });
    // summarize alone marks plaintext; ignore happens in index — still GROUP remote
    assert.equal(group.remoteType, 'GROUP');
  });
});

describe('auth isolation guard', () => {
  it('rejects production authDir overlap', async () => {
    const { resolveAuthDir } = await import(pathToFileURL(path.join(root, 'src/httpStatus.js')).href);
    assert.throws(
      () => resolveAuthDir({
        CANARY_AUTH_DIR: '/home/whatsapp/whatsapp-bot/data/baileys-auth-accounts/wa_f09d',
      }),
      /overlaps production auth/,
    );
    const ok = resolveAuthDir({ CANARY_AUTH_DIR: '/home/whatsapp/canary-auth/cut-salon-v7' });
    assert.ok(ok.includes('canary-auth'));
  });
});

describe('dto builder', () => {
  it('builds notify DTO with PN from remoteJidAlt', async () => {
    const { buildCanaryInboundDto } = await import(pathToFileURL(path.join(root, 'src/dto.js')).href);
    const built = await buildCanaryInboundDto({
      key: {
        id: 'MID1',
        remoteJid: '123@lid',
        remoteJidAlt: '201557994946@s.whatsapp.net',
        fromMe: false,
      },
      message: { conversation: 'v7 e2e inbox test 1' },
      messageTimestamp: 1700000000,
    }, { accountKey: 'wa_f09d54055f079b2624800b46', upsertType: 'notify' });
    assert.equal(built.ok, true);
    assert.equal(built.dto.upsertType, 'notify');
    assert.equal(built.dto.provider, 'baileys');
    assert.equal(built.dto.providerMessageId, 'false_201557994946@c.us_MID1');
    assert.equal(built.dto.externalContactKey, '201557994946@s.whatsapp.net');
    assert.equal(built.dto.content, 'v7 e2e inbox test 1');
  });

  it('rejects ciphertext / empty', async () => {
    const { buildCanaryInboundDto } = await import(pathToFileURL(path.join(root, 'src/dto.js')).href);
    const built = await buildCanaryInboundDto({
      key: { id: 'X', remoteJid: '1@lid', fromMe: false },
      messageStubType: 2,
    }, { accountKey: 'wa_test' });
    assert.equal(built.ok, false);
  });
});

describe('outbound gate', () => {
  it('blocks non-allowed destination', async () => {
    const { createOutboundGate } = await import(pathToFileURL(path.join(root, 'src/outbound.js')).href);
    const gate = createOutboundGate({ allowedPhoneDigits: '201557994946', enabled: true });
    assert.throws(() => gate.assertAllowed('201000000000'), /destination_not_allowed/);
    assert.equal(gate.assertAllowed('01557994946'), '201557994946');
  });
});
