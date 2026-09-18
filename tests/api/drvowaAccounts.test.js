import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('DRVOWA /api/accounts S2S auth', () => {
  let app;
  let resetManager;
  let tmpDir;
  let registry;
  let createManagedAccountRegistry;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-api-'));
    process.env.DRVOWA_MULTI_ACCOUNT_ENABLED = 'true';
    process.env.DRVOWA_RUNTIME_TOKEN = 'test-runtime-token';
    process.env.DRVOWA_MANAGED_REGISTRY_FILE = path.join(tmpDir, 'runtime-registry.json');

    ({ app } = require('../../server.js'));
    ({
      _resetWhatsAppAccountManagerForTests: resetManager,
      createManagedAccountRegistry,
    } = require('../../services/drvowa'));
    const { createWhatsAppAccountManager } = require('../../services/drvowa/accountManager');
    registry = createManagedAccountRegistry({
      filePath: process.env.DRVOWA_MANAGED_REGISTRY_FILE,
    });
    resetManager(createWhatsAppAccountManager({
      enabled: () => true,
      authBaseDir: path.join(tmpDir, 'accounts'),
      registry,
      createProvider: ({ accountKey, authBaseDir, onLoggedOut, printQrToTerminal }) => ({
        accountKey,
        authDir: path.join(authBaseDir, accountKey),
        printQrToTerminal: printQrToTerminal === true,
        async start() {
          return {
            accountKey,
            state: 'READY',
            ready: true,
            qrAvailable: false,
            lastConnectedAt: null,
            lastDisconnectAt: null,
            lastDisconnectCode: null,
            lastErrorCode: null,
            reconnectAttempts: 0,
          };
        },
        async stop() {
          return {
            accountKey,
            state: 'STOPPED',
            ready: false,
            qrAvailable: false,
            lastConnectedAt: null,
            lastDisconnectAt: null,
            lastDisconnectCode: null,
            lastErrorCode: null,
            reconnectAttempts: 0,
          };
        },
        getStatus() {
          return {
            accountKey,
            state: 'READY',
            ready: true,
            qrAvailable: false,
            lastConnectedAt: null,
            lastDisconnectAt: null,
            lastDisconnectCode: null,
            lastErrorCode: null,
            reconnectAttempts: 0,
          };
        },
        getQr() {
          return null;
        },
        async send() {
          return { success: true };
        },
      }),
    }));
  }, 30_000);

  afterEach(() => {
    resetManager(null);
    delete process.env.DRVOWA_MULTI_ACCOUNT_ENABLED;
    delete process.env.DRVOWA_RUNTIME_TOKEN;
    delete process.env.DRVOWA_MANAGED_REGISTRY_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects missing token with 401', async () => {
    const res = await request(app).get('/api/accounts/cut-salon/status');
    expect(res.status).toBe(401);
  });

  it('rejects invalid token with 401', async () => {
    const res = await request(app)
      .get('/api/accounts/cut-salon/status')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('allows valid token', async () => {
    const res = await request(app)
      .get('/api/accounts/cut-salon/status')
      .set('Authorization', 'Bearer test-runtime-token');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns disabled when multi-account flag is off', async () => {
    process.env.DRVOWA_MULTI_ACCOUNT_ENABLED = 'false';
    const res = await request(app)
      .get('/api/accounts/cut-salon/status')
      .set('Authorization', 'Bearer test-runtime-token');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MULTI_ACCOUNT_DISABLED');
  });

  it('POST /start persists RUNNING', async () => {
    const res = await request(app)
      .post('/api/accounts/wa_api_start/start')
      .set('Authorization', 'Bearer test-runtime-token');
    expect(res.status).toBe(200);
    expect(res.body.status.state).toBe('READY');
    expect(registry.getDesiredState('wa_api_start')).toBe('RUNNING');
  });

  it('POST /stop persists STOPPED', async () => {
    await request(app)
      .post('/api/accounts/wa_api_stop/start')
      .set('Authorization', 'Bearer test-runtime-token');
    const res = await request(app)
      .post('/api/accounts/wa_api_stop/stop')
      .set('Authorization', 'Bearer test-runtime-token');
    expect(res.status).toBe(200);
    expect(registry.getDesiredState('wa_api_stop')).toBe('STOPPED');
  });
});
