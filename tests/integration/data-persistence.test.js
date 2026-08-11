import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../server.js';
import { resetTestData, readDataFile, writeDataFile } from '../utils/test-helpers.js';

describe('Data persistence integration', () => {
  beforeEach(() => {
    resetTestData();
  });

  it('persists customers created via the API', async () => {
    await request(app).post('/api/customers').send({ phone: '201234567890', name: 'Alice' });
    await request(app).post('/api/customers').send({ phone: '201000111222', name: 'Bob' });

    const customers = readDataFile('customers.json');
    expect(customers).toHaveLength(2);
    expect(customers.map(c => c.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('reads customer data already present in the test directory', async () => {
    writeDataFile('customers.json', [{ phone: '201234567890', name: 'Charlie' }]);

    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Charlie');
  });

  it('persists templates updated via the API', async () => {
    await request(app).put('/api/templates/sale').send({ template: 'Hello {{customerName}}' });

    const templates = readDataFile('templates.json');
    expect(templates.sale).toBeDefined();
    expect(templates.sale.template).toBe('Hello {{customerName}}');
  });

  it('keeps test data isolated from the production data directory', () => {
    const dataDir = process.env.DATA_DIR;
    expect(dataDir).toBe('tests/data');
    expect(dataDir).not.toContain('data/');
  });
});
