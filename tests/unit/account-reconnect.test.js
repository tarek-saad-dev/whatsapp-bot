import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createWhatsAppAccountManager } = require('../../services/drvowa/accountManager');
const { clearLoggedOutAuth } = require('../../services/drvowa/baileysAuthReset');

function setup(createProvider, resetLoggedOutAuth = vi.fn()) {
  const registry = {
    setDesiredState: vi.fn(),
    getRuntimeEngine: () => 'BAILEYS_V6',
  };
  return {
    manager: createWhatsAppAccountManager({
      createProvider,
      createQueue: () => ({ enqueue: vi.fn() }),
      enabled: () => true,
      authBaseDir: '/tmp/managed-accounts',
      authBaseDirV7: '/tmp/managed-v7',
      registry,
      resetLoggedOutAuth,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    }),
    registry,
    resetLoggedOutAuth,
  };
}

describe('managed account reconnection', () => {
  it('actually restarts a DISCONNECTED socket when Connect is pressed', async () => {
    const provider = {
      getStatus: () => ({ state: 'DISCONNECTED', ready: false, qrAvailable: false }),
      start: vi.fn(async () => ({ state: 'DISCONNECTED', ready: false, qrAvailable: false })),
      stop: vi.fn(),
    };
    const { manager } = setup(() => provider);
    await manager.start('salon-1');
    await manager.start('salon-1', { rePair: true });
    expect(provider.start).toHaveBeenCalledTimes(2);
  });

  it('requires an explicit re-pair before clearing verified logged-out auth', async () => {
    const old = {
      getStatus: () => ({ state: 'LOGGED_OUT', ready: false }),
      start: vi.fn(async () => ({ state: 'LOGGED_OUT', ready: false })),
      stop: vi.fn(async () => ({ state: 'STOPPED', ready: false })),
    };
    const fresh = {
      getStatus: () => ({ state: 'QR_REQUIRED', ready: false, qrAvailable: true }),
      start: vi.fn(async () => ({ state: 'QR_REQUIRED', ready: false, qrAvailable: true })),
      stop: vi.fn(),
    };
    const createProvider = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh);
    const { manager, resetLoggedOutAuth } = setup(createProvider);
    expect((await manager.start('salon-2')).state).toBe('LOGGED_OUT');
    expect((await manager.start('salon-2')).state).toBe('LOGGED_OUT');
    expect(resetLoggedOutAuth).not.toHaveBeenCalled();
    expect((await manager.start('salon-2', { rePair: true })).state).toBe('QR_REQUIRED');
    expect(old.stop).toHaveBeenCalledTimes(1);
    expect(resetLoggedOutAuth).toHaveBeenCalledWith('/tmp/managed-accounts/salon-2');
    expect(fresh.start).toHaveBeenCalledTimes(1);
  });

  it('repairs a logged-out session detected on the initial start after reboot', async () => {
    const old = {
      getStatus: () => ({ state: 'STOPPED', ready: false }),
      start: vi.fn(async () => ({ state: 'LOGGED_OUT', ready: false })),
      stop: vi.fn(),
    };
    const fresh = {
      getStatus: () => ({ state: 'QR_REQUIRED', ready: false }),
      start: vi.fn(async () => ({ state: 'QR_REQUIRED', ready: false })),
      stop: vi.fn(),
    };
    const { manager, registry, resetLoggedOutAuth } = setup(vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh));
    expect((await manager.start('salon-3', { rePair: true })).state).toBe('QR_REQUIRED');
    expect(resetLoggedOutAuth).toHaveBeenCalledTimes(1);
    // The old provider's logout hook may have set STOPPED just before reset.
    expect(registry.setDesiredState).toHaveBeenLastCalledWith(
      'salon-3', 'RUNNING', { runtimeEngine: 'BAILEYS_V6' },
    );
  });

  it('coalesces overlapping start requests per account', async () => {
    let completeStart;
    const provider = {
      getStatus: () => ({ state: 'STARTING', ready: false }),
      start: vi.fn(() => new Promise((resolve) => { completeStart = resolve; })),
      stop: vi.fn(),
    };
    const { manager } = setup(() => provider);
    const first = manager.start('salon-4');
    const second = manager.start('salon-4');
    completeStart({ state: 'QR_REQUIRED', ready: false });
    await Promise.all([first, second]);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('keeps inbox, labels, and idempotency files while cleaning Baileys auth only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvo-reauth-'));
    try {
      for (const name of [
        'creds.json', 'session-123.json', 'app-state-sync-key-42.json',
        'inbox-spool.json', 'outbound-idempotency.json', 'lid-phone-map.json',
      ]) fs.writeFileSync(path.join(dir, name), '{}');
      expect(clearLoggedOutAuth(dir)).toBe(3);
      for (const name of ['creds.json', 'session-123.json', 'app-state-sync-key-42.json']) {
        expect(fs.existsSync(path.join(dir, name))).toBe(false);
      }
      for (const name of ['inbox-spool.json', 'outbound-idempotency.json', 'lid-phone-map.json']) {
        expect(fs.existsSync(path.join(dir, name))).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
