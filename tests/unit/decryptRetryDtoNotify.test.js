'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createInboxSpool } = require('../../services/inbox/inboxSpool');
const { createBaileysTransport } = require('../../services/transport/baileys/baileysTransport');
const { buildDrvowaInboundDto } = require('../../services/drvowa/inboundDto');

function makeInboundMsg({
  id = 'MSG123',
  remoteJid = '201555123456@s.whatsapp.net',
  text = 'hello',
  fromMe = false,
  ts = 1700000000,
} = {}) {
  return {
    key: { remoteJid, id, fromMe },
    message: { conversation: text },
    messageTimestamp: ts,
  };
}

class FakeSocket {
  constructor() {
    this.ev = new EventEmitter();
    this.end = async () => {};
  }
}

describe('decrypt-retry DTO is SaaS-notify', () => {
  let tmp;
  let prevDecryptMs;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decrypt-dto-'));
    prevDecryptMs = process.env.BAILEYS_DECRYPT_PENDING_MS;
    process.env.BAILEYS_DECRYPT_PENDING_MS = '8000';
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevDecryptMs === undefined) delete process.env.BAILEYS_DECRYPT_PENDING_MS;
    else process.env.BAILEYS_DECRYPT_PENDING_MS = prevDecryptMs;
  });

  it('correlated append produces DTO upsertType=notify (SaaS would accept)', async () => {
    const dtos = [];
    const socket = new FakeSocket();
    const transport = createBaileysTransport({
      authDir: path.join(tmp, 'auth'),
      lidMapFile: path.join(tmp, 'lid.json'),
      quarantineFile: path.join(tmp, 'q.json'),
      spool: createInboxSpool({ spoolFile: path.join(tmp, 'spool.json') }),
      logger: { info() {}, warn() {}, error() {} },
      makeSocket: () => {
        process.nextTick(() => socket.ev.emit('connection.update', { connection: 'open' }));
        return socket;
      },
      printQrToTerminal: false,
      onLiveInbound: (event) => {
        dtos.push(buildDrvowaInboundDto({
          accountKey: 'wa_test',
          providerMessageId: event.providerMessageId,
          externalContactKey: event.externalContactKey,
          fromMe: event.fromMe,
          isGroup: event.isGroup,
          messageTimestamp: event.messageTimestamp,
          receivedAt: event.receivedAt,
          upsertType: event.upsertType,
          content: typeof event.content === 'string'
            ? event.content
            : (event.content?.text || null),
        }));
      },
    });
    await transport.start();
    await new Promise((r) => setImmediate(r));

    const cipher = makeInboundMsg({ id: 'DTO1', text: 'x' });
    cipher.messageStubType = 2;
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [cipher] });
    await new Promise((r) => setImmediate(r));
    expect(dtos).toHaveLength(0);

    socket.ev.emit('messages.upsert', {
      type: 'append',
      messages: [makeInboundMsg({ id: 'DTO1', text: 'hello saas' })],
    });
    await new Promise((r) => setImmediate(r));

    expect(dtos).toHaveLength(1);
    expect(dtos[0].upsertType).toBe('notify');
    // Equivalent to SaaS ingest gate
    expect(dtos[0].upsertType.toLowerCase() !== 'notify').toBe(false);
    expect(String(dtos[0].providerMessageId || '')).toContain('DTO1');

    await transport.stop();
  });
});
