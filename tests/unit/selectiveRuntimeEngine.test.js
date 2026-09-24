'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWhatsAppAccountManager } = require('../../services/drvowa/accountManager');
const { createManagedAccountRegistry } = require('../../services/drvowa/managedAccountRegistry');
const { CONNECTION_STATES } = require('../../services/drvowa/connectionStates');
const { acquireAuthLock } = require('../../services/drvowa/v7/v7WorkerProvider');

function makeFakeV6Provider({ accountKey, authDir }) {
  let state = CONNECTION_STATES.STOPPED;
  return {
    accountKey,
    authDir,
    async start() {
      state = CONNECTION_STATES.READY;
      return this.getStatus();
    },
    async stop() {
      state = CONNECTION_STATES.STOPPED;
      return this.getStatus();
    },
    getStatus() {
      return {
        accountKey,
        state,
        ready: state === CONNECTION_STATES.READY,
        qrAvailable: false,
        lastConnectedAt: state === CONNECTION_STATES.READY ? new Date().toISOString() : null,
        lastDisconnectAt: null,
        lastDisconnectCode: null,
        lastErrorCode: null,
        reconnectAttempts: 0,
        authDir,
      };
    },
    getQr() { return null; },
    async send() {
      return { success: true, status: 'sent', providerMessageId: 'pmid_v6' };
    },
  };
}

function makeFakeV7Provider({ accountKey, authBaseDir }) {
  const authDir = path.join(authBaseDir, accountKey);
  let state = CONNECTION_STATES.STOPPED;
  let lock = null;
  return {
    accountKey,
    authDir,
    runtimeEngine: 'BAILEYS_V7',
    async start() {
      lock = acquireAuthLock(authDir);
      state = CONNECTION_STATES.READY;
      return this.getStatus();
    },
    async stop() {
      if (lock) {
        lock.release();
        lock = null;
      }
      state = CONNECTION_STATES.STOPPED;
      return this.getStatus();
    },
    getStatus() {
      return {
        accountKey,
        runtimeEngine: 'BAILEYS_V7',
        state,
        ready: state === CONNECTION_STATES.READY,
        qrAvailable: false,
        authDir,
        cryptoHealth: { cryptoHealth: 'UNKNOWN', plaintextInboundCount: 0 },
      };
    },
    getQr() { return null; },
    async send() {
      return { success: true, status: 'sent', providerMessageId: 'pmid_v7' };
    },
  };
}

describe('selective runtime engine dispatch', () => {
  let tmpDir;
  let registry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-engine-'));
    registry = createManagedAccountRegistry({
      filePath: path.join(tmpDir, 'registry.json'),
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('defaults to BAILEYS_V6', async () => {
    const manager = createWhatsAppAccountManager({
      enabled: () => true,
      registry,
      authBaseDir: path.join(tmpDir, 'v6'),
      authBaseDirV7: path.join(tmpDir, 'v7'),
      createProvider: makeFakeV6Provider,
      createV7Provider: makeFakeV7Provider,
    });
    const status = await manager.start('wa_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(status.runtimeEngine).toBe('BAILEYS_V6');
    expect(status.state).toBe(CONNECTION_STATES.READY);
    expect(registry.getRuntimeEngine('wa_aaaaaaaaaaaaaaaaaaaaaaaa')).toBe('BAILEYS_V6');
  });

  it('dispatches BAILEYS_V7 explicitly', async () => {
    const manager = createWhatsAppAccountManager({
      enabled: () => true,
      registry,
      authBaseDir: path.join(tmpDir, 'v6'),
      authBaseDirV7: path.join(tmpDir, 'v7'),
      createProvider: makeFakeV6Provider,
      createV7Provider: makeFakeV7Provider,
    });
    const status = await manager.start('wa_bbbbbbbbbbbbbbbbbbbbbbbb', {
      runtimeEngine: 'BAILEYS_V7',
    });
    expect(status.runtimeEngine).toBe('BAILEYS_V7');
    expect(status.state).toBe(CONNECTION_STATES.READY);
    expect(manager.getAuthDir('wa_bbbbbbbbbbbbbbbbbbbbbbbb')).toContain('v7');
  });

  it('rejects dual engine ownership', async () => {
    const manager = createWhatsAppAccountManager({
      enabled: () => true,
      registry,
      authBaseDir: path.join(tmpDir, 'v6'),
      authBaseDirV7: path.join(tmpDir, 'v7'),
      createProvider: makeFakeV6Provider,
      createV7Provider: makeFakeV7Provider,
    });
    await manager.start('wa_cccccccccccccccccccccccc', { runtimeEngine: 'BAILEYS_V6' });
    await expect(
      manager.start('wa_cccccccccccccccccccccccc', { runtimeEngine: 'BAILEYS_V7' }),
    ).rejects.toMatchObject({ code: 'ENGINE_OWNERSHIP_CONFLICT' });
  });

  it('auth lock prevents second v7 owner', () => {
    const authDir = path.join(tmpDir, 'lock-auth');
    const a = acquireAuthLock(authDir);
    expect(() => acquireAuthLock(authDir)).toThrow(/active owner/);
    a.release();
    const b = acquireAuthLock(authDir);
    b.release();
  });

  it('serializes outbound via queue concurrency 1', async () => {
    const order = [];
    const manager = createWhatsAppAccountManager({
      enabled: () => true,
      registry,
      authBaseDir: path.join(tmpDir, 'v6'),
      authBaseDirV7: path.join(tmpDir, 'v7'),
      createProvider: ({ accountKey, authDir }) => {
        const base = makeFakeV6Provider({ accountKey, authDir });
        return {
          ...base,
          async send(phone, message) {
            order.push('start');
            await new Promise((r) => setTimeout(r, 30));
            order.push('end');
            return { success: true, status: 'sent', providerMessageId: `id_${order.length}` };
          },
        };
      },
      createV7Provider: makeFakeV7Provider,
    });
    await manager.start('wa_dddddddddddddddddddddddd');
    await Promise.all([
      manager.send('wa_dddddddddddddddddddddddd', {
        phone: '201111111111',
        message: 'a',
        idempotencyKey: 'k1',
      }),
      manager.send('wa_dddddddddddddddddddddddd', {
        phone: '201111111111',
        message: 'b',
        idempotencyKey: 'k2',
      }),
    ]);
    expect(order).toEqual(['start', 'end', 'start', 'end']);
  });
});
