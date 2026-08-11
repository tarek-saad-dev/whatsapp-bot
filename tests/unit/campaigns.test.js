import { describe, it, expect, beforeEach } from 'vitest';
import * as campaignModel from '../../models/campaign.js';
import * as offerCampaignModel from '../../models/offerCampaign.js';
import * as campaignMessageModel from '../../models/campaignMessage.js';
import * as customerModel from '../../models/customer.js';
import * as campaignExecutor from '../../services/campaignExecutor.js';
import { resetTestData } from '../utils/test-helpers.js';

describe('Campaign models', () => {
  beforeEach(() => {
    resetTestData();
  });

  it('creates a segment campaign with default status draft', () => {
    const campaign = campaignModel.createCampaign({
      name: 'Test Segment Campaign',
      segmentType: 'today',
      messageTemplate: 'Hi {{name}}'
    });

    expect(campaign.status).toBe('draft');
    expect(campaign.name).toBe('Test Segment Campaign');
    expect(campaign.phoneNumbers).toEqual([]);
  });

  it('updates a campaign status and timestamp', () => {
    const campaign = campaignModel.createCampaign({
      name: 'Update Test',
      segmentType: 'this_week',
      messageTemplate: 'Hello'
    });

    const updated = campaignModel.updateCampaign(campaign.id, { status: 'active' });
    expect(updated.status).toBe('active');
    expect(updated.updatedAt).toBeDefined();
  });

  it('deletes a campaign', () => {
    const campaign = campaignModel.createCampaign({
      name: 'Delete Test',
      segmentType: 'today',
      messageTemplate: 'Bye'
    });

    expect(campaignModel.deleteCampaign(campaign.id)).toBe(true);
    expect(campaignModel.getCampaignById(campaign.id)).toBeUndefined();
  });

  it('rejects invalid offer campaign status', () => {
    expect(() =>
      offerCampaignModel.createCampaign({ offerId: 'offer-1', status: 'invalid' })
    ).toThrow('Invalid status');
  });

  it('validates status updates for offer campaigns', () => {
    const campaign = offerCampaignModel.createCampaign({ offerId: 'offer-1' });
    expect(() =>
      offerCampaignModel.updateCampaign(campaign.id, { status: 'invalid' })
    ).toThrow('Invalid status');
  });

  it('tracks sent and failed counts for offer campaigns', () => {
    const campaign = offerCampaignModel.createCampaign({ offerId: 'offer-1', totalRecipients: 2 });
    offerCampaignModel.incrementSentCount(campaign.id);
    offerCampaignModel.incrementFailedCount(campaign.id);

    const updated = offerCampaignModel.getCampaignById(campaign.id);
    expect(updated.sentCount).toBe(1);
    expect(updated.failedCount).toBe(1);
  });
});

describe('Campaign executor', () => {
  beforeEach(() => {
    resetTestData();
  });

  it('replaces {{name}} with the customer name', () => {
    customerModel.addCustomer({ phone: '201234567890', name: 'Alice' });
    const messages = campaignExecutor.prepareCampaignMessages({
      phoneNumbers: ['201234567890'],
      messageTemplate: 'Hi {{name}}'
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe('Hi Alice');
  });

  it('uses a default name when the customer is unknown', () => {
    const messages = campaignExecutor.prepareCampaignMessages({
      phoneNumbers: ['201000111222'],
      messageTemplate: 'Hello {{name}}'
    });

    expect(messages[0].message).toBe('Hello Customer');
  });

  it('throws when the campaign is not found', () => {
    expect(() => campaignExecutor.getCampaignExecutionData('nonexistent')).toThrow('Campaign not found');
  });

  it('throws when the campaign has no customers', () => {
    const campaign = campaignModel.createCampaign({
      name: 'Empty Campaign',
      segmentType: 'today',
      messageTemplate: 'Hi',
      phoneNumbers: []
    });

    expect(() => campaignExecutor.getCampaignExecutionData(campaign.id)).toThrow('Campaign has no customers');
  });
});

describe('Campaign message model', () => {
  beforeEach(() => {
    resetTestData();
  });

  it('creates a pending message by default', () => {
    const message = campaignMessageModel.createMessage({
      campaignId: 'campaign-1',
      clientId: 'client-1',
      phone: '201234567890',
      messageBody: 'Test'
    });

    expect(message.status).toBe('pending');
  });

  it('rejects invalid statuses', () => {
    expect(() =>
      campaignMessageModel.createMessage({
        campaignId: 'campaign-1',
        clientId: 'client-1',
        phone: '201234567890',
        messageBody: 'Test',
        status: 'unknown'
      })
    ).toThrow('Invalid status');
  });

  it('marks a message as sent with a timestamp', () => {
    const message = campaignMessageModel.createMessage({
      campaignId: 'campaign-1',
      clientId: 'client-1',
      phone: '201234567890',
      messageBody: 'Test'
    });

    const sent = campaignMessageModel.markAsSent(message.id);
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).toBeDefined();
  });
});
