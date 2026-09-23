import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { validateAccountKey } = require('../../services/drvowa/accountKey');
const { createWhatsAppAccountManager } = require('../../services/drvowa/accountManager');
const { CONNECTION_STATES } = require('../../services/drvowa/connectionStates');
const { buildDrvowaInboundDto } = require('../../services/drvowa/inboundDto');
const { shouldProcessUpsert } = require('../../services/transport/baileys/baileysMessageAdapter');
const { createSendQueue } = require('../../services/sendQueue');

function createFakeProviderFactory({ onCreate, hasAuth = true } = {}) {
  return function createProvider({ accountKey, authBaseDir, onLoggedOut, printQrToTerminal }) {
    const authDir = path.join(authBaseDir, accountKey);
    fs.mkdirSync(authDir, { recursive: true });
    let state = CONNECTION_STATES.STOPPED;
    let ready = false;
    let qr = null;
    let loggedOut = false;
    let reconnectAttempts = 0;
    let connectCalls = 0;
    const sendCalls = [];
    const sessionHasAuth = hasAuth;

    const provider = {
      accountKey,
      authDir,
      printQrToTerminal: printQrToTerminal === true,
      async start() {
        connectCalls += 1;
        if (loggedOut) {
          state = CONNECTION_STATES.LOGGED_OUT;
          ready = false;
          return this.getStatus();
        }
        state = CONNECTION_STATES.CONNECTING;
        if (!sessionHasAuth) {
          state = CONNECTION_STATES.QR_REQUIRED;
          ready = false;
          qr = 'EPHEMERAL_QR';
          return this.getStatus();
        }
        state = CONNECTION_STATES.READY;
        ready = true;
        qr = null;
        return this.getStatus();
      },
      async stop() {
        state = CONNECTION_STATES.STOPPED;
        ready = false;
        qr = null;
        return this.getStatus();
      },
      async send(phone, message) {
        if (loggedOut) {
          return { success: false, code: 'LOGGED_OUT' };
        }
        if (!ready) {
          return { success: false, code: 'NOT_READY' };
        }
        sendCalls.push({ phone, message, at: Date.now() });
        await new Promise((r) => setTimeout(r, 20));
        return { success: true, status: 'sent', phone, messageId: `m-${sendCalls.length}` };
      },
      getStatus() {
        return {
          accountKey,
          state: loggedOut ? CONNECTION_STATES.LOGGED_OUT : state,
          ready: loggedOut ? false : ready,
          qrAvailable: Boolean(qr),
          lastConnectedAt: ready ? new Date().toISOString() : null,
          lastDisconnectAt: null,
          lastDisconnectCode: loggedOut ? 401 : null,
          lastErrorCode: loggedOut ? 'LOGGED_OUT' : null,
          reconnectAttempts,
          authDir,
        };
      },
      getQr() {
        return qr;
      },
      _setQr(value) {
        qr = value;
        ready = false;
        state = CONNECTION_STATES.QR_REQUIRED;
      },
      _forceLoggedOut() {
        loggedOut = true;
        ready = false;
        state = CONNECTION_STATES.LOGGED_OUT;
        qr = null;
        if (typeof onLoggedOut === 'function') {
          onLoggedOut({ accountKey });
        }
      },
      _tryReconnect() {
        if (loggedOut) return false;
        reconnectAttempts += 1;
        return true;
      },
      _connectCalls: () => connectCalls,
      _sendCalls: () => sendCalls,
    };

    if (onCreate) onCreate(provider);
    return provider;
  };
}

describe('DRVOWA Phase 2A account manager', () => {
  let tmpDir;
  let managers;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-wa-'));
    managers = [];
  });

  afterEach(async () => {
    for (const m of managers) {
      await m.stopAll().catch(() => {});
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeManager(overrides = {}) {
    const created = [];
    const { createManagedAccountRegistry } = require('../../services/drvowa/managedAccountRegistry');
    const {
      registry: registryOverride,
      createProvider: createProviderOverride,
      ...rest
    } = overrides;
    const registry = registryOverride || createManagedAccountRegistry({
      filePath: path.join(tmpDir, 'runtime-registry.json'),
    });
    const manager = createWhatsAppAccountManager({
      enabled: () => true,
      authBaseDir: tmpDir,
      sendQueueMax: overrides.sendQueueMax || 2,
      registry,
      createProvider: createProviderOverride || createFakeProviderFactory({
        onCreate: (p) => created.push(p),
      }),
      ...rest,
      registry,
    });
    manager._createdProviders = created;
    managers.push(manager);
    return manager;
  }

  it('isolates A and B runtimes and auth paths', async () => {
    const manager = makeManager();
    await manager.start('account-a');
    await manager.start('account-b');

    expect(manager.listAccountKeys().sort()).toEqual(['account-a', 'account-b']);
    expect(manager.getAuthDir('account-a')).toBe(path.join(tmpDir, 'account-a'));
    expect(manager.getAuthDir('account-b')).toBe(path.join(tmpDir, 'account-b'));
    expect(manager.getAuthDir('account-a')).not.toBe(manager.getAuthDir('account-b'));
    expect(manager._createdProviders).toHaveLength(2);
  });

  it('duplicate start creates only one runtime', async () => {
    const manager = makeManager();
    await manager.start('solo');
    await manager.start('solo');
    await manager.start('solo');
    expect(manager._createdProviders).toHaveLength(1);
    expect(manager._createdProviders[0]._connectCalls()).toBe(1);
  });

  it('rejects path traversal account keys', () => {
    expect(validateAccountKey('../etc')).toEqual(expect.objectContaining({ ok: false }));
    expect(validateAccountKey('a/b')).toEqual(expect.objectContaining({ ok: false }));
    expect(validateAccountKey('C:\\abs')).toEqual(expect.objectContaining({ ok: false }));
    expect(validateAccountKey('cut-salon')).toEqual({ ok: true, accountKey: 'cut-salon' });
    expect(validateAccountKey('wa_abc123')).toEqual({ ok: true, accountKey: 'wa_abc123' });
  });

  it('enforces per-account send concurrency=1 and isolates A vs B queues', async () => {
    const manager = makeManager({ sendQueueMax: 10 });
    await manager.start('acc-a');
    await manager.start('acc-b');

    const aProvider = manager._createdProviders.find((p) => p.accountKey === 'acc-a');
    const bProvider = manager._createdProviders.find((p) => p.accountKey === 'acc-b');

    const origA = aProvider.send.bind(aProvider);
    const origB = bProvider.send.bind(bProvider);
    let aActive = 0;
    let aMax = 0;
    let bActive = 0;
    let bMax = 0;

    aProvider.send = async (...args) => {
      aActive += 1;
      aMax = Math.max(aMax, aActive);
      try {
        return await origA(...args);
      } finally {
        aActive -= 1;
      }
    };
    bProvider.send = async (...args) => {
      bActive += 1;
      bMax = Math.max(bMax, bActive);
      try {
        return await origB(...args);
      } finally {
        bActive -= 1;
      }
    };

    const results = await Promise.all([
      manager.send('acc-a', { phone: '201111', message: 'a1' }),
      manager.send('acc-a', { phone: '201111', message: 'a2' }),
      manager.send('acc-b', { phone: '202222', message: 'b1' }),
      manager.send('acc-b', { phone: '202222', message: 'b2' }),
    ]);

    expect(results.every((r) => r.success)).toBe(true);
    expect(aMax).toBe(1);
    expect(bMax).toBe(1);
  });

  it('bounded queue rejects when full', async () => {
    const manager = makeManager({ sendQueueMax: 1 });
    await manager.start('queued');
    const provider = manager._createdProviders[0];
    const orig = provider.send.bind(provider);
    provider.send = async (...args) => {
      await new Promise((r) => setTimeout(r, 40));
      return orig(...args);
    };

    const p1 = manager.send('queued', { phone: '201', message: '1' });
    await new Promise((r) => setTimeout(r, 5));
    const p2 = manager.send('queued', { phone: '201', message: '2' });
    const p3 = manager.send('queued', { phone: '201', message: '3' });

    const results = await Promise.all([p1, p2, p3]);
    expect(results.filter((r) => r.code === 'QUEUE_FULL').length).toBeGreaterThanOrEqual(1);
  });

  it('not-ready send fails immediately', async () => {
    const manager = makeManager();
    const result = await manager.send('idle-acc', { phone: '201', message: 'x' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('NOT_STARTED');
  });

  it('401/logged-out hard-stops without reconnect', async () => {
    const manager = makeManager();
    await manager.start('logout-acc');
    const provider = manager._createdProviders[0];
    provider._forceLoggedOut();

    const status = manager.status('logout-acc');
    expect(status.state).toBe(CONNECTION_STATES.LOGGED_OUT);
    expect(status.ready).toBe(false);
    expect(provider._tryReconnect()).toBe(false);

    const sendResult = await manager.send('logout-acc', { phone: '201', message: 'x' });
    expect(sendResult.success).toBe(false);
    expect(sendResult.code).toBe('LOGGED_OUT');

    const afterStart = await manager.start('logout-acc');
    expect(afterStart.state).toBe(CONNECTION_STATES.LOGGED_OUT);
    expect(provider._connectCalls()).toBe(1);
  });

  it('isolates QR and status between accounts', async () => {
    const manager = makeManager();
    await manager.start('qr-a');
    await manager.start('qr-b');
    const [a, b] = manager._createdProviders;
    a._setQr('QR_A_PAYLOAD');
    b._setQr('QR_B_PAYLOAD');

    expect(manager.qr('qr-a').qr).toBe('QR_A_PAYLOAD');
    expect(manager.qr('qr-b').qr).toBe('QR_B_PAYLOAD');
    expect(manager.status('qr-a').qrAvailable).toBe(true);
    expect(manager.status('qr-b').state).toBe(CONNECTION_STATES.QR_REQUIRED);
  });

  it('builds inbound DTO without BusinessID and trusts accountKey', () => {
    const dto = buildDrvowaInboundDto({
      accountKey: 'cut-salon',
      providerMessageId: 'ABC',
      externalContactKey: '2015',
      content: 'hi',
    });
    expect(dto.accountKey).toBe('cut-salon');
    expect(dto.provider).toBe('baileys');
    expect(dto).not.toHaveProperty('BusinessID');
    expect(dto).not.toHaveProperty('businessId');
  });

  it('ignores append/history upserts as live inbound', () => {
    expect(shouldProcessUpsert({ type: 'append', messages: [{}] }).accept).toBe(false);
    expect(shouldProcessUpsert({ type: 'append', messages: [{}] }).reason).toBe('not_live_notify');
    expect(shouldProcessUpsert({ type: 'notify', messages: [{}] }).accept).toBe(true);
  });

  it('send queue default remains concurrency 1', () => {
    const q = createSendQueue({ concurrency: 1, maxQueued: 3 });
    expect(q.getStats().concurrency).toBe(1);
    expect(q.getStats().maxQueued).toBe(3);
  });
});
