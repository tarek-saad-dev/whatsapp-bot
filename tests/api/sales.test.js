import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as whatsappService from '../../services/whatsappService.js';
import * as smsService from '../../services/smsService.js';
import { app } from '../../server.js';
import { resetTestData, writeDataFile } from '../utils/test-helpers.js';
import { getTemplatesFile } from '../../services/templateStorage.js';

const TOKEN = process.env.SQL_TRIGGER_TOKEN;

function writeTestTemplates(overrides = {}) {
  const defaults = {
    sale: {
      name: 'رسالة البيع',
      template: 'أستاذ {{customerName}}\nنورت Cut Salon ودايمًا منورنا 🙏✨',
      updatedAt: new Date().toISOString()
    },
    booking: {
      name: 'رسالة الحجز',
      template: 'أهلاً {{customerName}}،\n{{date}} {{time}}',
      updatedAt: new Date().toISOString()
    },
    first_time: {
      name: 'رسالة عميل أول مرة',
      template: 'أهلاً وسهلاً {{customerName}}! 🎉',
      updatedAt: new Date().toISOString()
    }
  };
  writeDataFile('templates.json', { ...defaults, ...overrides });
}

describe('Sales API', () => {
  beforeEach(() => {
    resetTestData();
    writeTestTemplates();
    vi.restoreAllMocks();
  });

  it('POST /api/sales/notify without token returns 401', async () => {
    const res = await request(app)
      .post('/api/sales/notify')
      .send({ phone: '201234567890', message: 'Hi' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/sales/notify uses the saved sale template, not an incoming message override', async () => {
    const sendMessage = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/sales/notify')
      .set('x-api-token', TOKEN)
      .send({
        phone: '201234567890',
        type: 'sale',
        message: 'This should be ignored',
        saleData: { customerName: 'Tarek' }
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.queued).toBe(true);
    expect(res.body.renderedMessage).toBe('أستاذ Tarek\nنورت Cut Salon ودايمًا منورنا 🙏✨');
    expect(sendMessage).toHaveBeenCalledWith('201234567890', res.body.renderedMessage);
    expect(sendMessage).not.toHaveBeenCalledWith('201234567890', 'This should be ignored');
  });

  it('POST /api/sales/notify changes the rendered message when the saved template changes', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    writeTestTemplates({
      sale: {
        name: 'مخصص',
        template: 'رسالة البيع الجديدة للعميل {{customerName}}',
        updatedAt: new Date().toISOString()
      }
    });

    const res = await request(app)
      .post('/api/sales/notify')
      .set('x-api-token', TOKEN)
      .send({
        phone: '201234567890',
        type: 'sale',
        saleData: { customerName: 'Tarek' }
      });

    expect(res.body.renderedMessage).toBe('رسالة البيع الجديدة للعميل Tarek');
    expect(res.body.renderedMessage).not.toContain('{{customerName}}');
  });

  it('POST /api/sales/notify response includes the same template file used by /api/whatsapp/send', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/sales/notify')
      .set('x-api-token', TOKEN)
      .send({
        phone: '201234567890',
        type: 'sale',
        saleData: { customerName: 'Tarek' }
      });

    expect(res.body.templateSource).toBe(getTemplatesFile());
  });

  it('POST /api/sales/send-message still queues a raw WhatsApp message for backward compatibility', async () => {
    const sendMessage = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/sales/send-message')
      .set('x-api-token', TOKEN)
      .send({ phone: '201234567890', message: 'Direct message' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith('201234567890', 'Direct message');
  });

  it('POST /api/sales/send-message requires phone and message', async () => {
    const res = await request(app)
      .post('/api/sales/send-message')
      .set('x-api-token', TOKEN)
      .send({ phone: '201234567890' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Phone and message are required');
  });

  it('GET /api/sales/status returns WhatsApp readiness', async () => {
    const res = await request(app).get('/api/sales/status').set('x-api-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
  });

  it('POST /api/sales/notify for first_time customers also sends SMS using the saved template', async () => {
    const sendMessage = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    const sendSMS = vi.spyOn(smsService, 'sendSMS').mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/sales/notify')
      .set('x-api-token', TOKEN)
      .send({
        phone: '201234567890',
        type: 'first_time',
        saleData: { customerName: 'Alice' }
      });

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalled();
    expect(sendSMS).toHaveBeenCalled();
    expect(res.body.renderedMessage).toContain('Alice');
  });

  it('POST /api/sales/reinitialize resets the WhatsApp driver', async () => {
    vi.spyOn(whatsappService, 'reinitialize').mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/sales/reinitialize')
      .set('x-api-token', TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
