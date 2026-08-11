import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server.js';

describe('Health API', () => {
  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });
});
