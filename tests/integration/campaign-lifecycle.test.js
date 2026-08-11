import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as database from '../../services/database.js';
import { app } from '../../server.js';
import { resetTestData, readDataFile } from '../utils/test-helpers.js';

describe('Campaign lifecycle integration', () => {
  beforeEach(() => {
    resetTestData();
    vi.clearAllMocks();
  });

  it('builds audience, creates an offer campaign, and starts it', async () => {
    // 1. Create an offer
    const offer = await request(app).post('/api/offers').send({ name: 'Lifecycle Offer' });
    expect(offer.status).toBe(201);

    // 2. Add targeting rules
    await request(app)
      .post(`/api/offers/${offer.body.id}/targeting`)
      .send({ city: 'Cairo', minVisits: 1 });

    // 3. Mock the SQL database to return one matching client
    vi.spyOn(database, 'executeQuery').mockResolvedValue([
      {
        clientId: 1,
        phone: '201234567890',
        Mobile: '201234567890',
        name: 'Alice',
        ClientID: 1
      }
    ]);

    const build = await request(app).post(`/api/offers/${offer.body.id}/build-audience`);
    expect(build.status).toBe(200);
    expect(build.body.success).toBe(true);
    expect(build.body.audienceCount).toBe(1);

    // 4. Create an offer-based campaign
    const campaign = await request(app).post('/api/campaigns').send({ offerId: offer.body.id });
    expect(campaign.status).toBe(201);
    expect(campaign.body.offerId).toBe(offer.body.id);

    // 5. Start the campaign - this creates messages from the audience
    const start = await request(app).post(`/api/campaigns/offers/${campaign.body.id}/start`);
    expect(start.status).toBe(200);
    expect(start.body.success).toBe(true);
    expect(start.body.messages.total).toBe(1);
    expect(start.body.messages.pending).toBe(1);

    // 6. Verify data was persisted to the isolated test data directory
    const messages = readDataFile('campaignMessages.json');
    expect(messages).toHaveLength(1);
    expect(messages[0].phone).toBe('201234567890');
    expect(messages[0].status).toBe('pending');
  });
});
