import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as database from '../../services/database.js';
import { app } from '../../server.js';
import { resetTestData } from '../utils/test-helpers.js';

describe('Offers API', () => {
  beforeEach(() => {
    resetTestData();
    vi.restoreAllMocks();
  });

  it('POST /api/offers creates an offer', async () => {
    const res = await request(app).post('/api/offers').send({ name: 'Summer Sale' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Summer Sale');
    expect(res.body.status).toBe('draft');
  });

  it('POST /api/offers requires a name', async () => {
    const res = await request(app).post('/api/offers').send({ description: 'No name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Name is required');
  });

  it('GET /api/offers/:id returns the offer with targeting rules', async () => {
    const create = await request(app).post('/api/offers').send({ name: 'Test Offer' });
    const res = await request(app).get(`/api/offers/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test Offer');
    expect(res.body.targetingRules).toEqual([]);
  });

  it('PUT /api/offers/:id updates an offer', async () => {
    const create = await request(app).post('/api/offers').send({ name: 'Old' });
    const res = await request(app).put(`/api/offers/${create.body.id}`).send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
  });

  it('DELETE /api/offers/:id deletes an offer and its rules', async () => {
    const create = await request(app).post('/api/offers').send({ name: 'To Delete' });
    const res = await request(app).delete(`/api/offers/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('deleted');
  });

  it('POST /api/offers/:id/targeting creates a rule', async () => {
    const offer = await request(app).post('/api/offers').send({ name: 'Targeted' });
    const res = await request(app)
      .post(`/api/offers/${offer.body.id}/targeting`)
      .send({ city: 'Cairo', minVisits: 2 });

    expect(res.status).toBe(201);
    expect(res.body.city).toBe('Cairo');
    expect(res.body.minVisits).toBe(2);
  });

  it('GET /api/offers/:id/audience returns empty audience initially', async () => {
    const offer = await request(app).post('/api/offers').send({ name: 'Empty' });
    const res = await request(app).get(`/api/offers/${offer.body.id}/audience`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('POST /api/offers/:id/build-audience returns success even with no matches', async () => {
    vi.spyOn(database, 'executeQuery').mockResolvedValue([]);

    const offer = await request(app).post('/api/offers').send({ name: 'Build' });
    await request(app).post(`/api/offers/${offer.body.id}/targeting`).send({ city: 'Cairo' });

    const res = await request(app).post(`/api/offers/${offer.body.id}/build-audience`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.audienceCount).toBe(0);
  });
});
