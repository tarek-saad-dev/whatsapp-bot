import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createInboxSpool } = require('../../services/inbox/inboxSpool');
const { createInboxDeliveryWorker } = require('../../services/inbox/inboxDeliveryWorker');
const {
  createDrvowaInboundDeliveryWorker,
  classifyDrvowaOutcome,
  dtoFromSpoolRecord,
} = require('../../services/drvowa/drvowaInboundDeliveryWorker');
const { buildDrvowaInboundDto } = require('../../services/drvowa/inboundDto');
const { getDrvowaInboundUrl } = require('../../services/drvowa/s2sAuth');

describe('DRVOWA Phase 3A Part 2 inbound delivery', () => {
  let tmpDir;
  let prevToken;
  let prevBase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-inbound-'));
    prevToken = process.env.DRVOWA_RUNTIME_TOKEN;
    prevBase = process.env.DRVOWA_SAAS_BASE_URL;
    process.env.DRVOWA_RUNTIME_TOKEN = 'test-runtime-token';
    process.env.DRVOWA_SAAS_BASE_URL = 'http://127.0.0.1:3100';
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env.DRVOWA_RUNTIME_TOKEN;
    else process.env.DRVOWA_RUNTIME_TOKEN = prevToken;
    if (prevBase === undefined) delete process.env.DRVOWA_SAAS_BASE_URL;
    else process.env.DRVOWA_SAAS_BASE_URL = prevBase;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeNormalized(id, overrides = {}) {
    return {
      provider: 'baileys',
      providerMessageId: id,
      phone: '201555100001',
      text: 'hello',
      isGroup: false,
      direction: 'inbound',
      messageTimestamp: 1700000000,
      receivedAt: new Date().toISOString(),
      upsertType: 'notify',
      ...overrides,
    };
  }

  function makeWorker({ accountKey = 'wa_test_account_key_001', fetchImpl, spoolFile } = {}) {
    const spool = createInboxSpool({
      spoolFile: spoolFile || path.join(tmpDir, `${accountKey}-spool.json`),
    });
    const worker = createDrvowaInboundDeliveryWorker({
      accountKey,
      spool,
      fetchImpl,
      logger: { info() {}, warn() {}, error() {} },
      intervalMs: 60_000,
    });
    worker.start(60_000);
    return { spool, worker };
  }

  it('1. managed inbound persists before HTTP delivery', async () => {
    let resolveFetch;
    const fetchImpl = vi.fn(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { spool, worker } = makeWorker({ fetchImpl });
    const event = makeNormalized('pmid-persist-1');
    spool.capture(event);
    spool.attachDrvowaPayload(
      event.providerMessageId,
      buildDrvowaInboundDto({
        accountKey: 'wa_test_account_key_001',
        providerMessageId: event.providerMessageId,
        externalContactKey: event.phone,
        content: event.text,
      }),
    );
    expect(spool.getStats().pending).toBe(1);
    expect(fs.existsSync(spool.spoolFile)).toBe(true);

    const tickPromise = worker.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(spool.getStats().pending).toBe(1);

    resolveFetch({
      status: 200,
      json: async () => ({ success: true, outcome: 'accepted' }),
    });
    await tickPromise;
    expect(spool.getStats().pending).toBe(0);
    expect(spool.getStats().delivered).toBe(1);
  });

  it('2/3/4/5. posts correct endpoint, Bearer token, accountKey, no BusinessID', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, outcome: 'accepted' }),
    });
    const { spool, worker } = makeWorker({
      accountKey: 'wa_account_a_key_aaaaaa',
      fetchImpl,
    });
    const event = makeNormalized('pmid-auth-1');
    spool.capture(event, {
      drvowaDto: buildDrvowaInboundDto({
        accountKey: 'WRONG_KEY_SHOULD_OVERRIDE',
        providerMessageId: event.providerMessageId,
        externalContactKey: event.phone,
        content: event.text,
      }),
    });
    await worker.tick();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3100/api/runtime/whatsapp/inbound');
    expect(url).toBe(getDrvowaInboundUrl());
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-runtime-token');
    const body = JSON.parse(opts.body);
    expect(body.accountKey).toBe('wa_account_a_key_aaaaaa');
    expect(body.provider).toBe('baileys');
    expect(body).not.toHaveProperty('BusinessID');
    expect(body).not.toHaveProperty('businessId');
  });

  it('6. accepted response marks delivered', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, outcome: 'accepted' }),
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-acc'));
    await worker.tick();
    expect(spool.getRecord('pmid-acc').status).toBe('delivered');
  });

  it('7. duplicate response marks delivered', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, outcome: 'duplicate' }),
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-dup'));
    await worker.tick();
    expect(spool.getRecord('pmid-dup').status).toBe('delivered');
  });

  it('8. ignored 2xx response marks delivered', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, outcome: 'ignored', reason: 'from_me' }),
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-ign'));
    await worker.tick();
    expect(spool.getRecord('pmid-ign').status).toBe('delivered');
  });

  it('9. network error remains pending/retries', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-net'));
    await worker.tick();
    const record = spool.getRecord('pmid-net');
    expect(record.status).toBe('pending_delivery');
    expect(record.attempts).toBe(1);
    expect(Date.parse(record.nextRetryAt)).toBeGreaterThan(Date.now());
  });

  it('10. 500 retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-500'));
    await worker.tick();
    expect(spool.getRecord('pmid-500').status).toBe('pending_delivery');
    expect(spool.getRecord('pmid-500').attempts).toBe(1);
  });

  it('11. 429 retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 429,
      json: async () => ({ error: 'slow down' }),
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-429'));
    await worker.tick();
    expect(spool.getRecord('pmid-429').status).toBe('pending_delivery');
  });

  it('12. 400 quarantines', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 400,
      json: async () => ({ error: 'bad' }),
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-400'));
    await worker.tick();
    const record = spool.getRecord('pmid-400');
    expect(record.status).toBe('failed');
    expect(record.quarantinedAt).toBeTruthy();
  });

  it('13. 401/403 does not tight-loop', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-401'));
    spool.capture(makeNormalized('pmid-401b'));
    await worker.tick();
    // One attempt then break tick on AUTH_CONFIG
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const record = spool.getRecord('pmid-401');
    expect(record.status).toBe('pending_delivery');
    const delay = Date.parse(record.nextRetryAt) - Date.now();
    expect(delay).toBeGreaterThanOrEqual(50_000);
  });

  it('14. 404 mapping error does not tight-loop', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 404,
      json: async () => ({ error: 'unknown' }),
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-404'));
    spool.capture(makeNormalized('pmid-404b'));
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const delay = Date.parse(spool.getRecord('pmid-404').nextRetryAt) - Date.now();
    expect(delay).toBeGreaterThanOrEqual(50_000);
  });

  it('15. uncertain commit then duplicate retry is safe', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ success: true, outcome: 'duplicate' }),
      });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-uncertain'));
    await worker.tick();
    expect(spool.getRecord('pmid-uncertain').status).toBe('pending_delivery');

    const rec = spool.getRecord('pmid-uncertain');
    rec.nextRetryAt = new Date(0).toISOString();
    spool.persist();

    await worker.tick();
    expect(spool.getRecord('pmid-uncertain').status).toBe('delivered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('16. restart reloads pending spool and delivers', async () => {
    const spoolFile = path.join(tmpDir, 'restart-spool.json');
    const spool1 = createInboxSpool({ spoolFile });
    const event = makeNormalized('pmid-restart');
    spool1.capture(event, {
      drvowaDto: buildDrvowaInboundDto({
        accountKey: 'wa_restart_key_aaaaaaa',
        providerMessageId: event.providerMessageId,
        externalContactKey: event.phone,
        content: event.text,
      }),
    });
    expect(spool1.getStats().pending).toBe(1);

    // Simulate process stop — drop in-memory worker, reload spool from disk
    const spool2 = createInboxSpool({ spoolFile });
    expect(spool2.getStats().pending).toBe(1);
    expect(spool2.getRecord('pmid-restart').drvowaDto.accountKey).toBe(
      'wa_restart_key_aaaaaaa',
    );

    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, outcome: 'accepted' }),
    });
    const worker2 = createDrvowaInboundDeliveryWorker({
      accountKey: 'wa_restart_key_aaaaaaa',
      spool: spool2,
      fetchImpl,
      logger: { info() {}, warn() {}, error() {} },
    });
    await worker2.start(60_000);
    expect(spool2.getStats().delivered).toBe(1);
    expect(spool2.getStats().pending).toBe(0);
    // No duplicate local record
    expect(
      JSON.parse(fs.readFileSync(spoolFile, 'utf8')).records.filter(
        (r) => r.providerMessageId === 'pmid-restart',
      ),
    ).toHaveLength(1);
    worker2.stop();
  });

  it('17. two managed accounts remain isolated', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push(JSON.parse(opts.body).accountKey);
      return { status: 200, json: async () => ({ outcome: 'accepted' }) };
    });
    const a = makeWorker({ accountKey: 'wa_acct_aaaa', fetchImpl });
    const b = makeWorker({ accountKey: 'wa_acct_bbbb', fetchImpl });
    a.spool.capture(makeNormalized('pmid-a'));
    b.spool.capture(makeNormalized('pmid-b'));
    await Promise.all([a.worker.tick(), b.worker.tick()]);
    expect(calls.sort()).toEqual(['wa_acct_aaaa', 'wa_acct_bbbb']);
    expect(a.spool.getRecord('pmid-a').status).toBe('delivered');
    expect(b.spool.getRecord('pmid-b').status).toBe('delivered');
    expect(a.spool.hasProviderMessageId('pmid-b')).toBe(false);
    expect(b.spool.hasProviderMessageId('pmid-a')).toBe(false);
  });

  it('18. per-account delivery serialized', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      return { status: 200, json: async () => ({ outcome: 'accepted' }) };
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-s1'));
    spool.capture(makeNormalized('pmid-s2'));
    spool.capture(makeNormalized('pmid-s3'));
    await worker.tick();
    expect(maxActive).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('19. immediate tick after capture is supported (running worker)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: 'accepted' }),
    });
    const { spool, worker } = makeWorker({ fetchImpl });
    spool.capture(makeNormalized('pmid-tick'));
    // Transport calls worker.tick() immediately after capture — simulate that.
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(spool.getRecord('pmid-tick').status).toBe('delivered');
  });

  it('20. managed delivery does not alter legacy worker URL/body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 201,
      json: async () => ({ ok: true }),
    });
    const spool = createInboxSpool({
      spoolFile: path.join(tmpDir, 'legacy-spool.json'),
    });
    spool.capture({
      provider: 'whatsapp-web',
      providerMessageId: 'false_20100@c.us_LEGACY',
      phone: '20100',
      text: 'legacy',
      direction: 'inbound',
      isGroup: false,
      messageType: 'text',
      idSource: 'native',
      remoteJid: '20100@c.us',
      chatTitle: 'X',
      receivedAt: new Date().toISOString(),
    });
    const legacy = createInboxDeliveryWorker({
      spool,
      webhookUrl: 'http://127.0.0.1:5500/api/internal/messaging/inbox/whatsapp',
      webhookToken: 'cashier-token',
      fetchImpl,
    });
    legacy.start(60_000);
    await legacy.tick();
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://127.0.0.1:5500/api/internal/messaging/inbox/whatsapp',
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer cashier-token',
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.provider).toBe('whatsapp-web');
    expect(body).not.toHaveProperty('accountKey');
    legacy.stop();
  });

  it('classifies outcomes and reconstructs DTO after restart without drvowaDto', () => {
    expect(classifyDrvowaOutcome(200, { outcome: 'accepted' })).toBe('accepted');
    expect(classifyDrvowaOutcome(200, { outcome: 'duplicate' })).toBe('duplicate');
    expect(classifyDrvowaOutcome(200, { outcome: 'ignored' })).toBe('ignored');
    expect(classifyDrvowaOutcome(400, {})).toBe('quarantine');
    expect(classifyDrvowaOutcome(401, {})).toBe('auth_config');
    expect(classifyDrvowaOutcome(404, {})).toBe('mapping_config');
    expect(classifyDrvowaOutcome(500, {})).toBe('retry');

    const dto = dtoFromSpoolRecord(
      {
        providerMessageId: 'pmid-x',
        capturedAt: '2026-01-01T00:00:00.000Z',
        normalizedEvent: {
          phone: '201555',
          text: 'hi',
          isGroup: false,
          messageTimestamp: 1,
        },
      },
      'wa_from_provider',
    );
    expect(dto.accountKey).toBe('wa_from_provider');
    expect(dto.content).toBe('hi');
    expect(dto.externalContactKey).toBe('201555');
  });
});
