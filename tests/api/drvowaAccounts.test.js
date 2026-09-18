import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('DRVOWA /api/accounts S2S auth', () => {
  let app;
  let resetManager;

  beforeEach(() => {
    vi.resetModules();
    process.env.DRVOWA_MULTI_ACCOUNT_ENABLED = 'true';
    process.env.DRVOWA_RUNTIME_TOKEN = 'test-runtime-token';
    ({ app } = require('../../server.js'));
    ({ _resetWhatsAppAccountManagerForTests: resetManager } = require('../../services/drvowa'));
    const { createWhatsAppAccountManager } = require('../../services/drvowa/accountManager');
    resetManager(createWhatsAppAccountManager({
      enabled: () => true,
      createProvider: ({ accountKey }) => ({
        accountKey,
        authDir: `data/baileys-auth-accounts/${accountKey}`,
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
          return { accountKey, state: 'STOPPED', ready: false, qrAvailable: false };
        },
        getStatus() {
          return { accountKey, state: 'READY', ready: true, qrAvailable: false };
        },
        getQr() {
          return null;
        },
        async send() {
          return { success: true };
        },
      }),
    }));
  });

  afterEach(() => {
    resetManager(null);
    delete process.env.DRVOWA_MULTI_ACCOUNT_ENABLED;
    delete process.env.DRVOWA_RUNTIME_TOKEN;
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
});
