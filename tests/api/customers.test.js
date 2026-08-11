import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../server.js';
import { resetTestData } from '../utils/test-helpers.js';

describe('Customers API', () => {
  beforeEach(() => {
    resetTestData();
  });

  it('GET /api/customers returns an empty array initially', async () => {
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST /api/customers creates a customer', async () => {
    const res = await request(app)
      .post('/api/customers')
      .send({ phone: '201234567890', name: 'Alice' });

    expect(res.status).toBe(201);
    expect(res.body.phone).toBe('201234567890');
    expect(res.body.name).toBe('Alice');
  });

  it('POST /api/customers requires a phone number', async () => {
    const res = await request(app).post('/api/customers').send({ name: 'No Phone' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Phone number is required');
  });

  it('GET /api/customers/:phone returns the customer', async () => {
    await request(app).post('/api/customers').send({ phone: '201234567890', name: 'Alice' });
    const res = await request(app).get('/api/customers/201234567890');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice');
  });

  it('PUT /api/customers/:phone updates a customer', async () => {
    await request(app).post('/api/customers').send({ phone: '201234567890', name: 'Alice' });
    const res = await request(app)
      .put('/api/customers/201234567890')
      .send({ name: 'Alice Updated' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice Updated');
  });

  it('DELETE /api/customers/:phone deletes a customer', async () => {
    await request(app).post('/api/customers').send({ phone: '201234567890', name: 'Alice' });
    const res = await request(app).delete('/api/customers/201234567890');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Customer deleted successfully');
  });

  it('POST /api/customers/bulk-import imports customers', async () => {
    const res = await request(app).post('/api/customers/bulk-import').send({
      customers: [
        { phone: '201234567890', name: 'Alice' },
        { phone: '201000111222', name: 'Bob' }
      ]
    });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
  });
});
