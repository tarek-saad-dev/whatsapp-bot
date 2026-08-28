import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app } from '../../server.js';

const require = createRequire(import.meta.url);
const whatsappService = require('../../services/whatsappService');

describe('WhatsApp gateway API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/whatsapp/send — generic contract', () => {
    it('rejects an empty body', async () => {
      const res = await request(app).post('/api/whatsapp/send').send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeTruthy();
    });

    it('rejects typed sends when type is present', async () => {
      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ type: 'sale', phone: '01557994946', customerName: 'طارق', message: 'hello' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Typed sends are no longer supported');
    });

    it('rejects generic send without phone', async () => {
      const res = await request(app).post('/api/whatsapp/send').send({ message: 'hello' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('phone is required');
    });

    it('rejects generic send without message', async () => {
      const res = await request(app).post('/api/whatsapp/send').send({ phone: '01557994946' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('message is required');
    });

    it('rejects generic send with invalid phone', async () => {
      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ phone: '12345', message: 'hello' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('phone is invalid');
    });

    it('normalizes 01557994946 to 201557994946', async () => {
      const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
        success: true,
        status: 'sent',
        messageId: 'wa-test-1',
      });

      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ phone: '01557994946', message: 'رسالة عامة' });

      expect(res.status).toBe(200);
      expect(res.body.phone).toBe('201557994946');
      expect(res.body.type).toBe('generic');
      expect(sendMessageAndWait).toHaveBeenCalledWith(
        '201557994946',
        'رسالة عامة',
        expect.any(Number),
        expect.objectContaining({
          logContext: expect.objectContaining({ type: 'generic' }),
        }),
      );
    });

    it('normalizes +201557994946 to 201557994946', async () => {
      vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
        success: true,
        status: 'sent',
        messageId: 'wa-test-1',
      });

      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ phone: '+201557994946', message: 'test' });

      expect(res.status).toBe(200);
      expect(res.body.phone).toBe('201557994946');
    });

    it('sends { phone, message } with generic response shape', async () => {
      vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
        success: true,
        status: 'sent',
        messageId: 'wa-generic-1',
      });

      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ phone: '01557994946', message: 'رسالة عامة بدون type' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('sent');
      expect(res.body.messageId).toBe('wa-generic-1');
      expect(res.body.type).toBe('generic');
      expect(res.body.phone).toBe('201557994946');
      expect(res.body.message).toBe('رسالة عامة بدون type');
      expect(res.body.templateSource).toBe('generic');
      expect(res.body.sentAt).toBeTruthy();
    });

    it('does not require customerName for generic send', async () => {
      vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
        success: true,
        status: 'sent',
        messageId: 'wa-generic-2',
      });

      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ phone: '01557994946', message: 'بدون customerName' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.messageId).toBeTruthy();
    });

    it('accepts optional metadata object', async () => {
      vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
        success: true,
        status: 'sent',
        messageId: 'wa-generic-3',
      });

      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({
          phone: '01557994946',
          message: 'مع metadata',
          metadata: { source: 'pos', orderId: 'ORD-99' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.messageId).toBe('wa-generic-3');
    });

    it('returns 503 when WhatsApp is not ready', async () => {
      vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
        success: false,
        status: 'failed',
        error: 'WhatsApp Web is not ready. Please scan the QR code and try again.',
      });

      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ phone: '01557994946', message: 'test' });

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toContain('WhatsApp Web is not ready');
    });

    it('returns not_registered when phone is not on WhatsApp', async () => {
      vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
        success: false,
        status: 'not_registered',
        error: 'Phone number is not registered on WhatsApp',
        phone: '201039244023',
      });

      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ phone: '01039244023', message: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe('not_registered');
      expect(res.body.phone).toBe('201039244023');
    });

    it('returns 500 when generic send completes without messageId', async () => {
      vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
        success: true,
        status: 'sent',
      });

      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ phone: '01557994946', message: 'test' });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toContain('messageId');
    });

    it('returns a controlled 500 error when Selenium fails', async () => {
      vi.spyOn(whatsappService, 'sendMessageAndWait').mockRejectedValue(new Error('Chrome crashed'));

      const res = await request(app)
        .post('/api/whatsapp/send')
        .send({ phone: '01557994946', message: 'test' });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Failed to send');
      expect(res.body.error).not.toContain('Chrome crashed');
    });
  });

  describe('GET /api/whatsapp/status', () => {
    it('returns WhatsApp service status', async () => {
      vi.spyOn(whatsappService, 'getStatus').mockResolvedValue({
        ready: true,
        loggedIn: true,
      });

      const res = await request(app).get('/api/whatsapp/status');

      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.loggedIn).toBe(true);
    });

    it('returns 500 when status read fails', async () => {
      vi.spyOn(whatsappService, 'getStatus').mockRejectedValue(new Error('driver unavailable'));

      const res = await request(app).get('/api/whatsapp/status');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Failed to read WhatsApp status');
    });
  });

  describe('GET /api/whatsapp/inbox', () => {
    it('returns stored incoming messages', async () => {
      vi.spyOn(whatsappService, 'getInbox').mockReturnValue({
        listening: true,
        lastPollAt: '2026-08-28T06:00:00.000Z',
        lastError: null,
        pollIntervalMs: 5000,
        count: 1,
        messages: [
          {
            messageId: 'false_201557994946@c.us_1',
            chatTitle: 'Ahmed',
            phone: '201557994946',
            text: 'عايز أطلب',
          },
        ],
      });

      const res = await request(app).get('/api/whatsapp/inbox');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.listening).toBe(true);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].text).toBe('عايز أطلب');
    });
  });

  describe('POST /api/whatsapp/inbox/start', () => {
    it('starts the inbox listener', async () => {
      vi.spyOn(whatsappService, 'startInboxListener').mockResolvedValue({
        listening: true,
        lastPollAt: null,
        lastError: null,
        pollIntervalMs: 5000,
        count: 0,
      });

      const res = await request(app).post('/api/whatsapp/inbox/start').send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.listening).toBe(true);
      expect(whatsappService.startInboxListener).toHaveBeenCalledWith({ initDriver: true });
    });

    it('returns 500 when Chrome/WhatsApp cannot start', async () => {
      vi.spyOn(whatsappService, 'startInboxListener').mockRejectedValue(new Error('QR required'));

      const res = await request(app).post('/api/whatsapp/inbox/start').send({});

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Failed to start the inbox listener');
    });
  });

  describe('POST /api/whatsapp/inbox/stop', () => {
    it('stops the inbox listener', async () => {
      vi.spyOn(whatsappService, 'stopInboxListener').mockReturnValue({
        listening: false,
        lastPollAt: null,
        lastError: null,
        pollIntervalMs: 5000,
        count: 0,
      });

      const res = await request(app).post('/api/whatsapp/inbox/stop').send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.listening).toBe(false);
    });
  });
});
