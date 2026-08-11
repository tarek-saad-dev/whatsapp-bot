import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../server.js';
import { resetTestData } from '../utils/test-helpers.js';

describe('Campaigns API', () => {
  beforeEach(() => {
    resetTestData();
  });

  it('POST /api/campaigns creates a segment campaign', async () => {
    const res = await request(app).post('/api/campaigns').send({
      name: 'Segment Campaign',
      segmentType: 'today',
      messageTemplate: 'Hi {{name}}'
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Segment Campaign');
    expect(res.body.segmentType).toBe('today');
  });

  it('POST /api/campaigns requires name and segmentType for segment campaigns', async () => {
    const res = await request(app).post('/api/campaigns').send({ name: 'Missing segment' });
    expect(res.status).toBe(400);
  });

  it('GET /api/campaigns returns all campaigns', async () => {
    await request(app).post('/api/campaigns').send({
      name: 'Campaign One',
      segmentType: 'today',
      messageTemplate: 'Hi'
    });

    const res = await request(app).get('/api/campaigns');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('PUT /api/campaigns/:id updates a campaign', async () => {
    const create = await request(app).post('/api/campaigns').send({
      name: 'Old',
      segmentType: 'today',
      messageTemplate: 'Hi'
    });

    const res = await request(app).put(`/api/campaigns/${create.body.id}`).send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
  });

  it('DELETE /api/campaigns/:id deletes a campaign', async () => {
    const create = await request(app).post('/api/campaigns').send({
      name: 'Delete',
      segmentType: 'today',
      messageTemplate: 'Hi'
    });

    const res = await request(app).delete(`/api/campaigns/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Campaign deleted successfully');
  });

  it('POST /api/campaigns creates an offer-based campaign when offerId is provided', async () => {
    const offer = await request(app).post('/api/offers').send({ name: 'Offer Campaign' });
    const res = await request(app).post('/api/campaigns').send({ offerId: offer.body.id });

    expect(res.status).toBe(201);
    expect(res.body.offerId).toBe(offer.body.id);
    expect(res.body.status).toBe('draft');
  });

  it('POST /api/campaigns/:id/execute returns execution data', async () => {
    const create = await request(app).post('/api/campaigns').send({
      name: 'Exec',
      segmentType: 'today',
      messageTemplate: 'Hi {{name}}',
      phoneNumbers: ['201234567890']
    });

    const res = await request(app).post(`/api/campaigns/${create.body.id}/execute`);
    expect(res.status).toBe(200);
    expect(res.body.totalMessages).toBe(1);
  });
});
