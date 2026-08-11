import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../server.js';
import { resetTestData, readDataFile } from '../utils/test-helpers.js';

describe('Templates API', () => {
  beforeEach(() => {
    resetTestData();
  });

  it('GET /api/templates returns templates', async () => {
    const res = await request(app).get('/api/templates');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.templates).toBeDefined();
    expect(res.body.templates.sale).toBeDefined();
    expect(res.body.templates.sale.template).toBeTruthy();
  });

  it('PUT /api/templates/:type saves a template', async () => {
    const res = await request(app).put('/api/templates/sale').send({
      template: 'Hello {{customerName}}'
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.type).toBe('sale');
    expect(res.body.template).toBe('Hello {{customerName}}');
    expect(res.body.updatedAt).toBeTruthy();

    const saved = readDataFile('templates.json');
    expect(saved.sale.template).toBe('Hello {{customerName}}');
  });

  it('GET /api/templates/:type returns the saved template', async () => {
    await request(app).put('/api/templates/sale').send({
      template: 'Hello {{customerName}}'
    });

    const res = await request(app).get('/api/templates/sale');
    expect(res.status).toBe(200);
    expect(res.body.template).toBe('Hello {{customerName}}');
  });

  it('POST /api/templates/preview renders a template with sample data', async () => {
    const res = await request(app).post('/api/templates/preview').send({
      type: 'sale',
      template: 'Hi {{customerName}}, order {{orderId}}',
      data: { customerName: 'Alice', orderId: '42' }
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Hi Alice, order 42');
  });

  it('POST /api/templates/preview removes lines with missing optional fields', async () => {
    const res = await request(app).post('/api/templates/preview').send({
      type: 'sale',
      template: 'Hi {{customerName}}\nInvoice: {{invoiceNumber}}\nPay: {{paymentMethod}}',
      data: { customerName: 'Alice' }
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Hi Alice');
  });

  it('POST /api/templates/preview returns 400 when customerName is missing', async () => {
    const res = await request(app).post('/api/templates/preview').send({
      type: 'sale',
      template: 'Hello {{customerName}}',
      data: {}
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('customerName is required');
  });
});
