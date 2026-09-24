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

describe('no outbound API surface', () => {
  it('package does not export send helpers', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    assert.equal(text.includes('sendMessage'), false);
    const index = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
    assert.equal(/sock\.sendMessage\(/.test(index), false);
    assert.equal(/\.sendMessage\s*\(/.test(index), false);
  });
});
