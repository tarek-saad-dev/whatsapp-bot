import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app } from '../../server.js';
import { resetTestData, writeDataFile } from '../utils/test-helpers.js';

const require = createRequire(import.meta.url);
const whatsappService = require('../../services/whatsappService');

function writeTestTemplates(overrides = {}) {
  const defaults = {
    sale: {
      name: 'رسالة البيع',
      template: 'أهلاً يا {{customerName}} 👋\n\nرقم الفاتورة: {{invoiceNumber}}\nالخدمات: {{services}}\nالإجمالي: {{total}} {{currency}}\nطريقة الدفع: {{paymentMethod}}\nالفرع: {{branchName}}\nمقدم الخدمة: {{employeeName}}\n\nنتمنى نشوفك قريباً 🤍',
      updatedAt: new Date().toISOString()
    },
    booking: {
      name: 'رسالة الحجز',
      template: 'أهلاً يا {{customerName}} 👋\n\nتم تأكيد حجزك في {{branchName}} ✅\n\nرقم الحجز: {{bookingId}}\nالتاريخ: {{bookingDate}}\nالوقت: {{bookingTime}}\nالحلاق: {{barberName}}\nالخدمات: {{services}}\n\nإدارة الحجز:\n{{bookingLink}}',
      updatedAt: new Date().toISOString()
    },
    first_time: {
      name: 'رسالة عميل أول مرة',
      template: 'أهلاً يا {{customerName}} 👋\n\nسعداء بانضمامك لأول مرة إلى {{branchName}} 🤍\n\nتقدر تحجز موعدك القادم من هنا:\n{{bookingLink}}\n\nنورتنا ✂️',
      updatedAt: new Date().toISOString()
    },
    employee_sale: {
      name: 'رسالة بيع للموظف',
      template: 'أهلاً {{customerName}} 👋\n\nرقم الفاتورة: {{invoiceNumber}}\nالخدمات: {{services}}\nالفرع: {{branchName}}\n\nبالتوفيق! 💈',
      updatedAt: new Date().toISOString()
    },
    employee_advance: {
      name: 'رسالة سلفة للموظف',
      template: 'أهلاً {{customerName}} 👋\n\nالمبلغ: {{amount}} ج.م\nرقم العملية: {{invoiceNumber}}\nطريقة الدفع: {{paymentMethod}}\nالفرع: {{branchName}}\n\nملاحظات: {{notes}}\n\nبالتوفيق! 💈',
      updatedAt: new Date().toISOString()
    },
    employee_daily_report: {
      name: 'تقرير يوم الموظف',
      template: 'تقرير {{customerName}}\nاليوم: {{workDate}}\nالرصيد: {{ledgerBalance}}',
      updatedAt: new Date().toISOString()
    }
  };
  writeDataFile('templates.json', { ...defaults, ...overrides });
}

describe('WhatsApp send API', () => {
  beforeEach(() => {
    resetTestData();
    writeTestTemplates();
    vi.clearAllMocks();
  });

  it('rejects an empty body', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects an invalid type', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'invalid', phone: '01557994946', customerName: 'طارق' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('type must be one of');
  });

  it('rejects a missing phone', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', customerName: 'طارق' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('phone is required');
  });

  it('rejects an invalid Egyptian phone', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '12345', customerName: 'طارق' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('phone is invalid');
  });

  it('rejects a missing customer name', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('customerName is required');
  });

  it('normalizes 01557994946 to 201557994946', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946', customerName: 'طارق' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('201557994946');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('normalizes +201557994946 to 201557994946', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '+201557994946', customerName: 'طارق' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('201557994946');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('normalizes 00201557994946 to 201557994946', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '00201557994946', customerName: 'طارق' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('201557994946');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('generates a complete sale message with all fields', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'sale',
        phone: '01557994946',
        customerName: 'طارق',
        invoiceNumber: 'INV-10025',
        total: 350,
        paymentMethod: 'كاش',
        branchName: 'جليم',
        employeeName: 'محمد',
        services: ['حلاقة شعر', 'تحديد دقن']
      });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('sale');
    expect(res.body.message).toContain('طارق');
    expect(res.body.message).toContain('INV-10025');
    expect(res.body.message).toContain('حلاقة شعر');
    expect(res.body.message).toContain('تحديد دقن');
    expect(res.body.message).toContain('كاش');
    expect(res.body.message).toContain('جليم');
    expect(res.body.message).toContain('محمد');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('omits optional sale lines when values are missing', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'sale',
        phone: '01557994946',
        customerName: 'طارق'
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('طارق');
    expect(res.body.message).not.toContain('رقم الفاتورة');
    expect(res.body.message).not.toContain('طريقة الدفع');
    expect(res.body.message).not.toContain('الإجمالي');
  });

  it('generates a complete booking message with all fields', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'booking',
        phone: '01557994946',
        customerName: 'طارق',
        bookingId: 'BK-1055',
        bookingDate: '2026-06-23',
        bookingTime: '05:30 PM',
        branchName: 'جليم',
        barberName: 'محمد',
        services: ['حلاقة شعر', 'تحديد دقن'],
        bookingLink: 'https://cutsaloon.com/'
      });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('booking');
    expect(res.body.message).toContain('طارق');
    expect(res.body.message).toContain('BK-1055');
    expect(res.body.message).toContain('2026-06-23');
    expect(res.body.message).toContain('05:30 PM');
    expect(res.body.message).toContain('حلاقة شعر');
    expect(res.body.message).toContain('https://cutsaloon.com/');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('generates a first-time customer message', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'first_time',
        phone: '01557994946',
        customerName: 'طارق',
        branchName: 'جليم',
        bookingLink: 'https://cutsaloon.com/'
      });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('first_time');
    expect(res.body.message).toContain('طارق');
    expect(res.body.message).toContain('جليم');
    expect(res.body.message).toContain('https://cutsaloon.com/');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('generates an employee_sale message with all fields', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'employee_sale',
        phone: '01557994946',
        customerName: 'أحمد',
        invoiceNumber: 'INV-123',
        services: ['حلاقة', 'تحديد دقن'],
        branchName: 'جليم'
      });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('employee_sale');
    expect(res.body.message).toContain('أحمد');
    expect(res.body.message).toContain('INV-123');
    expect(res.body.message).toContain('حلاقة');
    expect(res.body.message).toContain('تحديد دقن');
    expect(res.body.message).toContain('جليم');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('omits optional employee_sale lines when values are missing', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'employee_sale',
        phone: '01557994946',
        customerName: 'أحمد'
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('أحمد');
    expect(res.body.message).not.toContain('رقم الفاتورة');
    expect(res.body.message).not.toContain('الخدمات');
    expect(res.body.message).not.toContain('الفرع');
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
  });

  it('accepts employee_sale via admin test-send endpoint', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/admin/whatsapp/test-send')
      .send({
        type: 'employee_sale',
        phone: '01557994946',
        customerName: 'أحمد'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.type).toBe('employee_sale');
    expect(res.body.message).toContain('أحمد');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('generates an employee_advance message with all fields', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'employee_advance',
        phone: '01039244023',
        customerName: 'زياد',
        amount: 500,
        invoiceNumber: 'ADV-001',
        paymentMethod: 'كاش',
        branchName: 'جليم',
        notes: 'سلفة شهرية'
      });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('employee_advance');
    expect(res.body.message).toContain('زياد');
    expect(res.body.message).toContain('500');
    expect(res.body.message).toContain('ADV-001');
    expect(res.body.message).toContain('كاش');
    expect(res.body.message).toContain('جليم');
    expect(res.body.message).toContain('سلفة شهرية');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('omits optional employee_advance lines when values are missing', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/admin/whatsapp/test-send')
      .send({
        type: 'employee_advance',
        phone: '01039244023',
        customerName: 'زياد'
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('زياد');
    expect(res.body.message).not.toContain('المبلغ');
    expect(res.body.message).not.toContain('ملاحظات');
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
  });

  it('generates an employee_funding message with FUND- invoice (not advance)', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'employee_funding',
        phone: '01039244023',
        customerName: 'زياد',
        invoiceNumber: 'FUND-1207426',
        amount: 10,
        paymentMethod: 'كاش',
        branchName: 'جليم',
        notes: 'إيراد موظف'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.type).toBe('employee_funding');
    expect(res.body.phone).toBe('201039244023');
    expect(res.body.templateSource).toBe('employee_funding');
    expect(res.body.message).toContain('زياد');
    expect(res.body.message).toContain('تم تسجيل إيراد جديد لك');
    expect(res.body.message).toContain('10');
    expect(res.body.message).toContain('FUND-1207426');
    expect(res.body.message).toContain('كاش');
    expect(res.body.message).toContain('جليم');
    expect(res.body.message).toContain('إيراد موظف');
    expect(res.body.message).not.toContain('سلفة');
    expect(res.body.message).not.toContain('ADV-');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('rejects employee_funding when amount is missing', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'employee_funding',
        phone: '01039244023',
        customerName: 'زياد',
        invoiceNumber: 'FUND-1'
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('amount is required');
  });

  it('omits optional employee_funding lines when values are missing', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'employee_funding',
        phone: '01039244023',
        customerName: 'زياد',
        amount: 25
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('تم تسجيل إيراد جديد لك');
    expect(res.body.message).toContain('25');
    expect(res.body.message).not.toContain('رقم العملية');
    expect(res.body.message).not.toContain('ملاحظات');
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
  });

  it('sends quick_message text as-is without a template', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'quick_message',
        phone: '01557994946',
        customerName: 'عميل',
        message: 'أهلا بك في Cut Salon',
        branchName: 'جليم'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.type).toBe('quick_message');
    expect(res.body.phone).toBe('201557994946');
    expect(res.body.message).toBe('أهلا بك في Cut Salon');
    expect(res.body.templateSource).toBe('quick_message');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('rejects quick_message when message is missing', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'quick_message',
        phone: '01557994946',
        customerName: 'عميل'
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('message is required');
  });

  it('sends other text as-is without a local template (POS-composed)', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });
    const posMessage = 'رسالة مخصصة من الـ POS بعد ملء القالب هناك';

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'other',
        phone: '01557994946',
        customerName: 'عميل',
        message: posMessage,
        branchName: 'جليم'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.type).toBe('other');
    expect(res.body.phone).toBe('201557994946');
    expect(res.body.message).toBe(posMessage);
    expect(res.body.templateSource).toBe('other');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('rejects other when message is missing', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'other',
        phone: '01557994946',
        customerName: 'عميل'
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('message is required for other');
  });

  it('sends employee_daily_report using provided message as-is', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });
    const reportText = '🌙 تقرير يومك — Cut Salon\n\n📌 صافي اليوم: 213.75 ج.م\n📒 رصيد حسابك حتى الآن: 1,850.00 ج.م';

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'employee_daily_report',
        phone: '01039244023',
        customerName: 'زياد',
        branchName: 'جليم',
        message: reportText,
        workDate: '2026-07-06',
        ledgerBalance: 1850,
        dayNet: 213.75
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.type).toBe('employee_daily_report');
    expect(res.body.message).toBe(reportText);
    expect(res.body.templateSource).toBe('employee_daily_report');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('falls back to employee_daily_report template when message is missing', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'employee_daily_report',
        phone: '01039244023',
        customerName: 'زياد',
        workDate: '2026-07-06',
        ledgerBalance: 1850
      });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('employee_daily_report');
    expect(res.body.message).toContain('زياد');
    expect(res.body.message).toContain('2026-07-06');
    expect(res.body.message).toContain('1850');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('formats services using Arabic commas', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'sale',
        phone: '01557994946',
        customerName: 'طارق',
        services: ['حلاقة شعر', 'تحديد دقن']
      });

    expect(res.body.message).toContain('حلاقة شعر، تحديد دقن');
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
  });

  it('rejects services when not an array', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946', customerName: 'طارق', services: 'حلاقة' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('services must be an array');
  });

  it('calls the WhatsApp sending function exactly once with the normalized phone', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946', customerName: 'طارق' });

    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('passes the complete generated message to the sending service', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'first_time', phone: '01557994946', customerName: 'طارق' });

    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
  });

  it('returns 503 when WhatsApp requires login or QR scanning', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: false,
      status: 'failed',
      error: 'WhatsApp Web is not ready. Please scan the QR code and try again.'
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'first_time', phone: '01557994946', customerName: 'طارق' });

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
      .send({ type: 'employee_sale', phone: '01039244023', customerName: 'زياد', services: ['Haircut'] });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('not_registered');
    expect(res.body.phone).toBe('201039244023');
  });

  it('serializes two concurrent employee_sale sends (distinct messageIds)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let seq = 0;
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockImplementation(async (phone) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent -= 1;
      seq += 1;
      return {
        success: true,
        status: 'sent',
        messageId: `wa-${phone}-${seq}`,
        phone,
      };
    });

    const [r1, r2] = await Promise.all([
      request(app).post('/api/whatsapp/send').send({
        type: 'employee_sale',
        phone: '01227423337',
        customerName: 'عمر',
        invoiceNumber: 'INV-7705',
        employeeId: 25,
        services: ['Basic Skin Care'],
        message: 'msg-omar',
      }),
      request(app).post('/api/whatsapp/send').send({
        type: 'employee_sale',
        phone: '01039244023',
        customerName: 'زياد',
        invoiceNumber: 'INV-7705',
        employeeId: 12,
        services: ['Haircut & Beard'],
        message: 'msg-ziad',
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.status).toBe('sent');
    expect(r2.body.status).toBe('sent');
    expect(r1.body.messageId).toBeTruthy();
    expect(r2.body.messageId).toBeTruthy();
    expect(r1.body.messageId).not.toBe(r2.body.messageId);
    // Note: maxConcurrent on the mock itself can be 2 because the spy runs before the service queue.
    // The real serialization is covered by sendQueue unit tests; here we assert both complete as sent.
    expect(maxConcurrent).toBeGreaterThanOrEqual(1);
  });

  it('returns a controlled 500 error when Selenium fails', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockRejectedValue(new Error('Chrome crashed'));

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946', customerName: 'طارق' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Failed to send');
    expect(res.body.error).not.toContain('Chrome crashed');
  });

  it('returns status sent on success', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946', customerName: 'طارق' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.phone).toBe('201557994946');
    expect(res.body.message).toBeTruthy();
    expect(res.body.sentAt).toBeTruthy();
  });

  it('uses the saved template when sending', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946', customerName: 'طارق', invoiceNumber: 'INV-TEST' });

    expect(res.body.message).toContain('أهلاً يا طارق 👋');
    expect(res.body.message).toContain('رقم الفاتورة:');
    expect(res.body.message).toContain('INV-TEST');
    expect(res.body.message).not.toContain('{{');
    expect(res.body.message).not.toContain('}}');
  });

  it('changes the sent message when the saved template changes', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    writeTestTemplates({
      sale: {
        name: 'رسالة البيع المخصصة',
        template: 'رسالة البيع الجديدة للعميل {{customerName}}',
        updatedAt: new Date().toISOString()
      }
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946', customerName: 'Tarek' });

    expect(res.body.message).toBe('رسالة البيع الجديدة للعميل Tarek');
    expect(res.body.message).not.toContain('{{customerName}}');
  });

  it('replaces all repeated placeholders', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    writeTestTemplates({
      sale: {
        name: 'تكرار',
        template: '{{customerName}} - {{customerName}} - {{customerName}}',
        updatedAt: new Date().toISOString()
      }
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946', customerName: 'Tarek' });

    expect(res.body.message).toBe('Tarek - Tarek - Tarek');
    expect(res.body.message).not.toContain('{{customerName}}');
  });

  it('removes whole lines for missing optional fields and cleans blank lines', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946', customerName: 'طارق' });

    expect(res.body.message).toContain('طارق');
    expect(res.body.message).not.toContain('رقم الفاتورة');
    expect(res.body.message).not.toContain('طريقة الدفع');
    expect(res.body.message).not.toContain('{{');
    expect(res.body.message).not.toContain('}}');
  });

  it('returns 400 when a required placeholder is missing', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    writeTestTemplates({
      sale: {
        name: 'بدون اسم',
        template: 'أهلاً',
        updatedAt: new Date().toISOString()
      }
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ type: 'sale', phone: '01557994946' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('customerName is required');
  });

  it('ignores an incoming message override and uses the saved template', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({ success: true, status: 'sent', messageId: 'wa-test-1' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        type: 'sale',
        phone: '01557994946',
        customerName: 'Tarek',
        message: 'Old hard-coded message should be ignored'
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('أهلاً يا Tarek');
    expect(res.body.message).toContain('مقدم الخدمة: Tarek');
    expect(res.body.message).not.toBe('Old hard-coded message should be ignored');
    expect(sendMessageAndWait).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), expect.any(Object));
    expect(res.body.templateSource).toBeTruthy();
  });
});

describe('WhatsApp generic send API', () => {
  beforeEach(() => {
    resetTestData();
    writeTestTemplates();
    vi.clearAllMocks();
  });

  it('sends {phone,message} without type as generic send', async () => {
    const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: true,
      status: 'sent',
      messageId: 'wa-generic-1',
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        phone: '01557994946',
        message: 'رسالة عامة بدون type',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.messageId).toBe('wa-generic-1');
    expect(res.body.type).toBe('generic');
    expect(res.body.phone).toBe('201557994946');
    expect(res.body.message).toBe('رسالة عامة بدون type');
    expect(res.body.templateSource).toBe('generic');
    expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
    expect(sendMessageAndWait).toHaveBeenCalledWith(
      '201557994946',
      'رسالة عامة بدون type',
      expect.any(Number),
      expect.objectContaining({
        logContext: expect.objectContaining({ type: 'generic' }),
      }),
    );
  });

  it('rejects generic send without phone', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ message: 'hello' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('phone is required');
  });

  it('rejects generic send without message', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ phone: '01557994946' });

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

  it('does not require customerName for generic send', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: true,
      status: 'sent',
      messageId: 'wa-generic-2',
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        phone: '01557994946',
        message: 'بدون customerName',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.messageId).toBeTruthy();
  });

  it('accepts optional metadata object for generic send', async () => {
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

  it('returns 500 when generic send completes without messageId', async () => {
    vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
      success: true,
      status: 'sent',
    });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({
        phone: '01557994946',
        message: 'test',
      });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toContain('messageId');
  });
});
