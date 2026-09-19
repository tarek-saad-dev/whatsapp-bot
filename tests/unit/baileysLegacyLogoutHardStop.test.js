'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const whatsappService = require('../../services/transport/baileysWhatsAppService');
const {
  createBaileysTransport,
} = require('../../services/transport/baileys/baileysTransport');

describe('legacy Baileys logout hard-stop', () => {
  const transport = whatsappService._transport;
  let spies = [];

  function spy(obj, method, impl) {
    const s = vi.spyOn(obj, method);
    if (impl) s.mockImplementation(impl);
    spies.push(s);
    return s;
  }

  beforeEach(() => {
    spies = [];
  });

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    vi.restoreAllMocks();
  });

  it('A. loggedOut sendMessageAndWait fails immediately with LOGGED_OUT', async () => {
    spy(transport, 'isReady', () => false);
    spy(transport, 'getStatus', () => ({
      ready: false,
      loggedOut: true,
      qrRequired: false,
      reconnectAttempts: 0,
    }));
    const connect = spy(transport, 'connect', async () => {
      throw new Error('connect must not be called');
    });
    const start = spy(transport, 'start', async () => {
      throw new Error('start must not be called');
    });

    const started = Date.now();
    const result = await whatsappService.sendMessageAndWait(
      '201555111111',
      'hello',
      120000,
    );
    const elapsed = Date.now() - started;

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.code).toBe('LOGGED_OUT');
    expect(result.error).toMatch(/logged out/i);
    expect(elapsed).toBeLessThan(3000);
    expect(connect).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('B. loggedOut send does not call transport.connect', async () => {
    spy(transport, 'isReady', () => false);
    spy(transport, 'getStatus', () => ({
      ready: false,
      loggedOut: true,
      qrRequired: false,
    }));
    const connect = spy(transport, 'connect', async () => ({}));

    await whatsappService.sendMessageAndWait('201555111111', 'hi', 5000);
    expect(connect).toHaveBeenCalledTimes(0);
  });

  it('C. multiple outbound calls while loggedOut still never reconnect', async () => {
    spy(transport, 'isReady', () => false);
    spy(transport, 'getStatus', () => ({
      ready: false,
      loggedOut: true,
      qrRequired: false,
    }));
    const connect = spy(transport, 'connect', async () => ({}));
    const start = spy(transport, 'start', async () => ({}));

    for (let i = 0; i < 5; i += 1) {
      const result = await whatsappService.sendMessageAndWait(
        '201555111111',
        `msg-${i}`,
        5000,
      );
      expect(result.code).toBe('LOGGED_OUT');
    }
    expect(connect).toHaveBeenCalledTimes(0);
    expect(start).toHaveBeenCalledTimes(0);
  });

  it('D. getOrCreateDriver while loggedOut does not start transport', async () => {
    spy(transport, 'isReady', () => false);
    spy(transport, 'getStatus', () => ({
      ready: false,
      loggedOut: true,
      qrRequired: false,
    }));
    const start = spy(transport, 'start', async () => ({}));

    await expect(whatsappService.getOrCreateDriver()).rejects.toMatchObject({
      code: 'LOGGED_OUT',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('E. temporarily not-ready but NOT loggedOut still attempts connect', async () => {
    let ready = false;
    spy(transport, 'isReady', () => ready);
    spy(transport, 'getStatus', () => ({
      ready,
      loggedOut: false,
      qrRequired: false,
    }));
    const connect = spy(transport, 'connect', async () => {
      ready = true;
    });
    spy(transport, 'send', async () => ({
      success: true,
      messageId: 'WA-TEMP-1',
      phone: '201555111111',
      chatId: '201555111111@c.us',
    }));

    const result = await whatsappService.sendMessageAndWait(
      '201555111111',
      'recover',
      10000,
    );
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('WA-TEMP-1');
    expect(connect).toHaveBeenCalled();
  });

  it('F. READY legacy send still sends normally', async () => {
    spy(transport, 'isReady', () => true);
    spy(transport, 'getStatus', () => ({
      ready: true,
      loggedOut: false,
      qrRequired: false,
    }));
    const connect = spy(transport, 'connect', async () => ({}));
    spy(transport, 'send', async () => ({
      success: true,
      messageId: 'WA-READY-1',
      phone: '201555111111',
      chatId: '201555111111@c.us',
    }));

    const result = await whatsappService.sendMessageAndWait(
      '201555111111',
      'ok',
      5000,
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('WA-READY-1');
    expect(connect).not.toHaveBeenCalled();
  });

  it('sendMessage while loggedOut does not call start', async () => {
    spy(transport, 'isReady', () => false);
    spy(transport, 'getStatus', () => ({
      ready: false,
      loggedOut: true,
      qrRequired: false,
    }));
    const start = spy(transport, 'start', async () => ({}));

    const result = await whatsappService.sendMessage('201555111111', 'bg');
    expect(result.success).toBe(false);
    expect(result.code).toBe('LOGGED_OUT');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('H. Baileys transport 401 marks loggedOut without internal reconnect', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-401-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('401 connection close sets loggedOut and does not schedule reconnect', async () => {
    let connectCalls = 0;
    const socket = new EventEmitter();
    socket.ev = socket;
    socket.end = vi.fn();

    const transport = createBaileysTransport({
      authDir: path.join(tmpDir, 'auth'),
      logger: { info() {}, warn() {}, error() {} },
      makeSocket: () => {
        connectCalls += 1;
        return socket;
      },
      useAuthState: async () => ({
        state: { creds: {} },
        saveCreds: async () => {},
      }),
      fetchVersion: async () => ({ version: [2, 3000, 0] }),
    });

    try {
      await transport.start();
      expect(connectCalls).toBe(1);

      socket.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error: { output: { statusCode: 401 }, message: 'logged out' },
        },
      });

      // Internal reconnect uses 1s+ backoff; wait past first window with no new connect.
      await new Promise((r) => setTimeout(r, 1500));

      const status = transport.getStatus();
      expect(status.loggedOut).toBe(true);
      expect(status.ready).toBe(false);
      expect(status.lastDisconnectCode).toBe(401);
      expect(connectCalls).toBe(1);

      // start again must not create another socket while loggedOut
      await transport.start();
      expect(connectCalls).toBe(1);

      const sendResult = await transport.send('201555111111', 'nope');
      expect(sendResult.code).toBe('LOGGED_OUT');
      expect(sendResult.sendAttempted).toBe(false);
    } finally {
      await transport.stop().catch(() => {});
    }
  });
});
