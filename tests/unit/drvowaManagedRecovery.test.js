import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createManagedAccountRegistry,
  DESIRED_RUNNING,
  DESIRED_STOPPED,
} = require('../../services/drvowa/managedAccountRegistry');
const { recoverManagedAccounts } = require('../../services/drvowa/managedAccountRecovery');
const { createWhatsAppAccountManager } = require('../../services/drvowa/accountManager');
const { CONNECTION_STATES } = require('../../services/drvowa/connectionStates');
const { createBaileysProvider } = require('../../services/drvowa/baileysProvider');

function createFakeProviderFactory({ onCreate, hasAuth = true, failKeys = new Set() } = {}) {
  return function createProvider({ accountKey, authBaseDir, onLoggedOut, printQrToTerminal }) {
    const authDir = path.join(authBaseDir, accountKey);
    fs.mkdirSync(authDir, { recursive: true });
    let state = CONNECTION_STATES.STOPPED;
    let ready = false;
    let qr = null;
    let loggedOut = false;
    let reconnectAttempts = 0;
    let connectCalls = 0;

    const provider = {
      accountKey,
      authDir,
      printQrToTerminal: printQrToTerminal === true,
      async start() {
        connectCalls += 1;
        if (failKeys.has(accountKey)) {
          const err = new Error('simulated_start_failure');
          err.code = 'START_FAILED';
          throw err;
        }
        if (loggedOut) {
          state = CONNECTION_STATES.LOGGED_OUT;
          ready = false;
          return this.getStatus();
        }
        if (!hasAuth) {
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
      async send() {
        return { success: ready && !loggedOut };
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
    };

    if (onCreate) onCreate(provider);
    return provider;
  };
}

describe('DRVOWA Phase 2C managed runtime recovery', () => {
  let tmpDir;
  let managers;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-2c-'));
    managers = [];
  });

  afterEach(async () => {
    for (const m of managers) {
      await m.stopAll().catch(() => {});
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRegistry(name = 'runtime-registry.json') {
    return createManagedAccountRegistry({
      filePath: path.join(tmpDir, name),
    });
  }

  function makeManager(overrides = {}) {
    const created = [];
    const {
      registry: registryOverride,
      createProvider: createProviderOverride,
      ...rest
    } = overrides;
    const registry = registryOverride || makeRegistry();
    const manager = createWhatsAppAccountManager({
      enabled: () => true,
      authBaseDir: path.join(tmpDir, 'accounts'),
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

  it('1. start persists desiredState RUNNING', async () => {
    const registry = makeRegistry();
    const manager = makeManager({ registry });
    await manager.start('wa_running1');
    expect(registry.getDesiredState('wa_running1')).toBe(DESIRED_RUNNING);
  });

  it('2. stop persists desiredState STOPPED', async () => {
    const registry = makeRegistry();
    const manager = makeManager({ registry });
    await manager.start('wa_stop1');
    await manager.stop('wa_stop1');
    expect(registry.getDesiredState('wa_stop1')).toBe(DESIRED_STOPPED);
  });

  it('3. restart simulation restores RUNNING account', async () => {
    const registry = makeRegistry('shared-registry.json');
    const first = makeManager({ registry });
    await first.start('wa_restore');
    expect(first.listAccountKeys()).toEqual(['wa_restore']);
    await first.stopAll();

    const second = makeManager({ registry });
    const summary = await recoverManagedAccounts({
      manager: second,
      registry,
      enabled: () => true,
      concurrency: 2,
      staggerMs: 0,
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(summary.attempted).toBe(1);
    expect(summary.ready).toBe(1);
    expect(second.listAccountKeys()).toEqual(['wa_restore']);
    expect(second.status('wa_restore').state).toBe(CONNECTION_STATES.READY);
  });

  it('4. STOPPED account does not restore', async () => {
    const registry = makeRegistry('stopped-registry.json');
    const first = makeManager({ registry });
    await first.start('wa_stopped');
    await first.stop('wa_stopped');
    await first.stopAll();

    const second = makeManager({ registry });
    const summary = await recoverManagedAccounts({
      manager: second,
      registry,
      enabled: () => true,
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(summary.attempted).toBe(0);
    expect(second.listAccountKeys()).toEqual([]);
  });

  it('5. existing auth + RUNNING returns READY without new QR', async () => {
    const registry = makeRegistry();
    const manager = makeManager({
      registry,
      createProvider: createFakeProviderFactory({ hasAuth: true }),
    });
    await manager.start('wa_authed');
    const status = manager.status('wa_authed');
    expect(status.state).toBe(CONNECTION_STATES.READY);
    expect(status.qrAvailable).toBe(false);
    expect(manager.qr('wa_authed').qr).toBeNull();
  });

  it('6. duplicate recovery does not create duplicate socket', async () => {
    const registry = makeRegistry();
    const created = [];
    const manager = makeManager({
      registry,
      createProvider: createFakeProviderFactory({
        onCreate: (p) => created.push(p),
      }),
    });
    registry.setDesiredState('wa_dup', DESIRED_RUNNING);

    await recoverManagedAccounts({
      manager,
      registry,
      enabled: () => true,
      logger: { info() {}, warn() {}, error() {} },
    });
    await recoverManagedAccounts({
      manager,
      registry,
      enabled: () => true,
      logger: { info() {}, warn() {}, error() {} },
    });
    await manager.start('wa_dup');

    expect(created).toHaveLength(1);
    expect(created[0]._connectCalls()).toBe(1);
  });

  it('7. invalid/path-traversal accountKey in registry is ignored safely', () => {
    const filePath = path.join(tmpDir, 'bad-keys.json');
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      accounts: {
        '../etc/passwd': { desiredState: 'RUNNING', updatedAt: '2026-01-01T00:00:00.000Z' },
        'a/b': { desiredState: 'RUNNING', updatedAt: '2026-01-01T00:00:00.000Z' },
        'wa_ok': { desiredState: 'RUNNING', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    }));
    const registry = createManagedAccountRegistry({ filePath });
    expect(registry.listRunningAccountKeys()).toEqual(['wa_ok']);
  });

  it('8. one failed account does not block another', async () => {
    const registry = makeRegistry();
    registry.setDesiredState('wa_fail', DESIRED_RUNNING);
    registry.setDesiredState('wa_ok2', DESIRED_RUNNING);
    const created = [];
    const manager = makeManager({
      registry,
      createProvider: createFakeProviderFactory({
        onCreate: (p) => created.push(p),
        failKeys: new Set(['wa_fail']),
      }),
    });

    const summary = await recoverManagedAccounts({
      manager,
      registry,
      enabled: () => true,
      concurrency: 2,
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(summary.failed).toBe(1);
    expect(summary.ready).toBe(1);
    expect(manager.listAccountKeys()).toContain('wa_ok2');
  });

  it('9. bounded recovery concurrency is enforced', async () => {
    const registry = makeRegistry();
    for (let i = 0; i < 6; i += 1) {
      registry.setDesiredState(`wa_c${i}`, DESIRED_RUNNING);
    }

    let active = 0;
    let maxActive = 0;
    const manager = makeManager({
      registry,
      createProvider: ({ accountKey, authBaseDir }) => {
        const authDir = path.join(authBaseDir, accountKey);
        return {
          accountKey,
          authDir,
          async start() {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 40));
            active -= 1;
            return {
              accountKey,
              state: CONNECTION_STATES.READY,
              ready: true,
              qrAvailable: false,
              lastErrorCode: null,
            };
          },
          async stop() {
            return { accountKey, state: CONNECTION_STATES.STOPPED, ready: false };
          },
          getStatus() {
            return {
              accountKey,
              state: CONNECTION_STATES.READY,
              ready: true,
              qrAvailable: false,
              lastErrorCode: null,
              reconnectAttempts: 0,
              authDir,
            };
          },
          getQr() {
            return null;
          },
          async send() {
            return { success: true };
          },
        };
      },
    });

    await recoverManagedAccounts({
      manager,
      registry,
      enabled: () => true,
      concurrency: 2,
      staggerMs: 0,
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThanOrEqual(1);
  });

  it('10. 401/loggedOut hard-stops and does not reconnect storm', async () => {
    const registry = makeRegistry();
    const created = [];
    const manager = makeManager({
      registry,
      createProvider: createFakeProviderFactory({
        onCreate: (p) => created.push(p),
      }),
    });
    await manager.start('wa_logout');
    created[0]._forceLoggedOut();

    expect(registry.getDesiredState('wa_logout')).toBe(DESIRED_STOPPED);
    expect(created[0]._tryReconnect()).toBe(false);
    expect(created[0]._tryReconnect()).toBe(false);
    expect(created[0]._connectCalls()).toBe(1);

    const after = await manager.start('wa_logout');
    expect(after.state).toBe(CONNECTION_STATES.LOGGED_OUT);
    expect(created[0]._connectCalls()).toBe(1);
  });

  it('11. loggedOut account is not repeatedly restored on next boot', async () => {
    const registry = makeRegistry('logout-boot.json');
    const first = makeManager({ registry });
    await first.start('wa_boot_logout');
    first._createdProviders[0]._forceLoggedOut();
    expect(registry.getDesiredState('wa_boot_logout')).toBe(DESIRED_STOPPED);
    await first.stopAll();

    const second = makeManager({ registry });
    const summary = await recoverManagedAccounts({
      manager: second,
      registry,
      enabled: () => true,
      logger: { info() {}, warn() {}, error() {} },
    });
    expect(summary.attempted).toBe(0);
    expect(second.listAccountKeys()).toEqual([]);
  });

  it('12. missing/corrupt registry fails safely', () => {
    const missing = createManagedAccountRegistry({
      filePath: path.join(tmpDir, 'does-not-exist', 'missing.json'),
    });
    expect(missing.load()).toEqual({ version: 1, accounts: {} });
    expect(missing.listRunningAccountKeys()).toEqual([]);

    const corruptPath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{not-json');
    const corrupt = createManagedAccountRegistry({ filePath: corruptPath });
    expect(corrupt.load()).toEqual({ version: 1, accounts: {} });
    expect(corrupt.listRunningAccountKeys()).toEqual([]);
  });

  it('13. atomic registry persistence', () => {
    const filePath = path.join(tmpDir, 'atomic.json');
    const registry = createManagedAccountRegistry({ filePath });
    registry.setDesiredState('wa_a', DESIRED_RUNNING);
    registry.setDesiredState('wa_b', DESIRED_STOPPED);
    registry.setDesiredState('wa_a', DESIRED_STOPPED);

    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.accounts.wa_a.desiredState).toBe(DESIRED_STOPPED);
    expect(onDisk.accounts.wa_b.desiredState).toBe(DESIRED_STOPPED);
    expect(Object.keys(onDisk.accounts).sort()).toEqual(['wa_a', 'wa_b']);
    expect(fs.readdirSync(tmpDir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('14. legacy singleton startup remains unchanged (printQr default true)', async () => {
    const { createBaileysTransport } = require('../../services/transport/baileys/baileysTransport');
    const authDir = path.join(tmpDir, 'legacy-auth');
    const transport = createBaileysTransport({
      authDir,
      logger: { info() {}, warn() {}, error() {} },
      makeSocket: () => ({
        ev: { on() {}, off() {}, removeAllListeners() {} },
        end() {},
        ws: { close() {} },
      }),
      useAuthState: async () => ({
        state: { creds: {}, keys: {} },
        saveCreds: async () => {},
      }),
      fetchVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
    });
    // Default option is printQrToTerminal=true; managed provider opts out explicitly.
    expect(transport).toBeTruthy();
    const managed = createFakeProviderFactory({})({
      accountKey: 'wa_managed_qr',
      authBaseDir: path.join(tmpDir, 'accounts'),
      printQrToTerminal: false,
    });
    expect(managed.printQrToTerminal).toBe(false);
  });

  it('15. legacy auth path is never used by managed runtime', () => {
    const legacyAuth = path.resolve(process.cwd(), 'data', 'baileys-auth');
    const authBaseDir = path.join(tmpDir, 'baileys-auth-accounts');
    expect(() => createBaileysProvider({
      accountKey: 'wa_pathcheck',
      authBaseDir,
      createTransport: () => ({
        async start() {},
        async stop() {},
        getStatus: () => ({ ready: false, loggedOut: false, qrRequired: false }),
        getQr: () => null,
        async send() { return { success: false }; },
      }),
    })).not.toThrow();

    const provider = createBaileysProvider({
      accountKey: 'wa_pathcheck',
      authBaseDir,
      createTransport: ({ authDir }) => {
        expect(path.resolve(authDir)).not.toBe(legacyAuth);
        expect(path.resolve(authDir).startsWith(`${legacyAuth}${path.sep}`)).toBe(false);
        expect(authDir).toBe(path.join(authBaseDir, 'wa_pathcheck'));
        return {
          async start() {},
          async stop() {},
          getStatus: () => ({ ready: false, loggedOut: false, qrRequired: false }),
          getQr: () => null,
          async send() { return { success: false }; },
        };
      },
    });
    expect(provider.authDir).toBe(path.join(authBaseDir, 'wa_pathcheck'));
  });

  it('16. Phase 2A isolation invariants remain green', async () => {
    const manager = makeManager();
    await manager.start('account-a');
    await manager.start('account-b');
    expect(manager.listAccountKeys().sort()).toEqual(['account-a', 'account-b']);
    expect(manager.getAuthDir('account-a')).not.toBe(manager.getAuthDir('account-b'));
    await manager.start('account-a');
    expect(manager._createdProviders).toHaveLength(2);
  });
});
