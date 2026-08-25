import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app } from '../../server.js';
import { resetTestData, writeDataFile } from '../utils/test-helpers.js';

const require = createRequire(import.meta.url);
const whatsappService = require('../../services/whatsappService');
const { useMemoryDeliveryStore } = require('../../services/idempotency/deliveryStore');
const { computeRequestHash } = require('../../services/idempotency/requestHash');
const { STATUSES, CODES } = require('../../services/idempotency/constants');

const PHONE = '01557994946';
const NORMALIZED = '201557994946';
const MESSAGE = 'رسالة generic مع مفتاح';
const KEY = 'sale:1:40004:customer_receipt';

function writeTestTemplates() {
  writeDataFile('templates.json', {
    sale: {
      name: 'رسالة البيع',
      template: 'أهلاً يا {{customerName}} 👋',
      updatedAt: new Date().toISOString(),
    },
  });
}

describe('WhatsApp generic send idempotency', () => {
  let store;

  beforeEach(() => {
    resetTestData();
    writeTestTemplates();
    vi.clearAllMocks();
    store = useMemoryDeliveryStore();
    vi.spyOn(whatsappService, 'isReady').mockResolvedValue(true);
    vi.spyOn(whatsappService, 'getOrCreateDriver').mockResolvedValue({});
  });

  it('generic without idempotencyKey still sends exactly once with the old contract', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: true,
      status: 'sent',
      messageId: 'wa-generic-plain',
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, metadata: { source: 'pos' } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.messageId).toBe('wa-generic-plain');
    expect(res.body).not.toHaveProperty('idempotentReplay');
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
    expect(await store.getByKey(KEY)).toBeNull();
  });

  it('first request with a key sends once and stores sent + messageId', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: true,
      status: 'sent',
      messageId: 'wa-idemp-1',
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.messageId).toBe('wa-idemp-1');
    expect(res.body.idempotentReplay).toBe(false);
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);

    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.SENT);
    expect(row.providerMessageId).toBe('wa-idemp-1');
    expect(row.phone).toBe(NORMALIZED);
    expect(row.requestHash).toBe(computeRequestHash(NORMALIZED, MESSAGE));
  });

  it('replay of the same key + payload does not send WhatsApp again', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: true,
      status: 'sent',
      messageId: 'wa-idemp-1',
    });

    const first = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY, metadata: { source: 'a' } });
    const second = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY, metadata: { source: 'b' } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
    expect(second.body.status).toBe('sent');
    expect(second.body.messageId).toBe('wa-idemp-1');
    expect(second.body.idempotentReplay).toBe(true);
    expect(first.body.messageId).toBe(second.body.messageId);
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
  });

  it('same key + different payload returns 409 IDEMPOTENCY_CONFLICT', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: true,
      status: 'sent',
      messageId: 'wa-idemp-1',
    });

    await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: 'رسالة مختلفة', idempotencyKey: KEY });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(CODES.IDEMPOTENCY_CONFLICT);
    expect(res.body.success).toBe(false);
  });

  it('concurrent requests with the same key invoke WhatsApp send once', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockImplementation(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inflight -= 1;
      return { success: true, status: 'sent', messageId: 'wa-concurrent-1' };
    });

    const payload = { phone: PHONE, message: MESSAGE, idempotencyKey: KEY };
    const [a, b] = await Promise.all([
      request(app).post('/api/whatsapp/send').send(payload),
      request(app).post('/api/whatsapp/send').send(payload),
    ]);

    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
    expect(maxInflight).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 409).toBe(true);
    expect([a, b].some((r) => r.status === 200 && r.body.messageId === 'wa-concurrent-1')).toBe(true);
    const replays = [a, b].filter((r) => r.body.idempotentReplay === true);
    const inProgress = [a, b].filter((r) => r.body.code === CODES.IDEMPOTENCY_IN_PROGRESS);
    expect(replays.length + inProgress.length).toBeGreaterThanOrEqual(1);
  });

  it('processing row does not resend', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait');
    store.seed({
      idempotencyKey: KEY,
      requestHash: computeRequestHash(NORMALIZED, MESSAGE),
      phone: NORMALIZED,
      status: STATUSES.PROCESSING,
      attemptCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(CODES.IDEMPOTENCY_IN_PROGRESS);
    expect(sendMessageAndWait).not.toHaveBeenCalled();
  });

  it('stale processing becomes unknown and does not resend', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait');
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    store.seed({
      idempotencyKey: KEY,
      requestHash: computeRequestHash(NORMALIZED, MESSAGE),
      phone: NORMALIZED,
      status: STATUSES.PROCESSING,
      attemptCount: 1,
      createdAt: stale,
      updatedAt: stale,
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe(CODES.DELIVERY_STATUS_UNKNOWN);
    expect(sendMessageAndWait).not.toHaveBeenCalled();
    expect((await store.getByKey(KEY)).status).toBe(STATUSES.UNKNOWN);
  });

  it('unknown row does not resend', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait');
    store.seed({
      idempotencyKey: KEY,
      requestHash: computeRequestHash(NORMALIZED, MESSAGE),
      phone: NORMALIZED,
      status: STATUSES.UNKNOWN,
      attemptCount: 1,
      createdAt: new Date(),
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe(CODES.DELIVERY_STATUS_UNKNOWN);
    expect(sendMessageAndWait).not.toHaveBeenCalled();
  });

  it('retryable_failed can retry and increments AttemptCount', async () => {
    store.seed({
      idempotencyKey: KEY,
      requestHash: computeRequestHash(NORMALIZED, MESSAGE),
      phone: NORMALIZED,
      status: STATUSES.RETRYABLE_FAILED,
      attemptCount: 1,
      createdAt: new Date(),
    });
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: true,
      status: 'sent',
      messageId: 'wa-retry-1',
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe('wa-retry-1');
    expect(res.body.idempotentReplay).toBe(false);
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.SENT);
    expect(row.attemptCount).toBe(2);
  });

  it('safe pre-send not-ready is retryable_failed and does not send', async () => {
    whatsappService.isReady.mockResolvedValue(false);
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait');

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe(CODES.RETRYABLE_FAILED);
    expect(sendMessageAndWait).not.toHaveBeenCalled();
    expect((await store.getByKey(KEY)).status).toBe(STATUSES.RETRYABLE_FAILED);
  });

  it('not_registered before send is retryable_failed', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: false,
      status: 'not_registered',
      error: 'Phone number is not registered on WhatsApp',
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('not_registered');
    expect(res.body.code).toBe(CODES.RETRYABLE_FAILED);
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
    expect((await store.getByKey(KEY)).status).toBe(STATUSES.RETRYABLE_FAILED);
  });

  it('ambiguous send failure is unknown and is not retried', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockRejectedValue(new Error('Chrome crashed after compose'));

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe(CODES.DELIVERY_STATUS_UNKNOWN);
    expect((await store.getByKey(KEY)).status).toBe(STATUSES.UNKNOWN);

    const retry = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });
    expect(retry.status).toBe(503);
    expect(retry.body.code).toBe(CODES.DELIVERY_STATUS_UNKNOWN);
  });

  it('success without messageId is unknown', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: true,
      status: 'sent',
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: KEY });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe(CODES.DELIVERY_STATUS_UNKNOWN);
    expect((await store.getByKey(KEY)).status).toBe(STATUSES.UNKNOWN);
  });

  it('rejects typed send with idempotencyKey and does not write the ledger', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait');

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'sale',
        phone: PHONE,
        customerName: 'طارق',
        message: 'ignored',
        idempotencyKey: KEY,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Typed sends are no longer supported');
    expect(sendMessageAndWait).not.toHaveBeenCalled();
    expect(await store.getByKey(KEY)).toBeNull();
  });

  it('rejects an empty idempotencyKey', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait');
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: PHONE, message: MESSAGE, idempotencyKey: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('idempotencyKey');
    expect(sendMessageAndWait).not.toHaveBeenCalled();
  });
});
