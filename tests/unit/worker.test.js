import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as campaignMessageModel from '../../models/campaignMessage.js';
import * as offerCampaignModel from '../../models/offerCampaign.js';
import * as campaignWorker from '../../services/campaignWorker.js';
import * as whatsappService from '../../services/whatsappService.js';
import { resetTestData } from '../utils/test-helpers.js';

describe('campaignWorker', () => {
  beforeEach(() => {
    resetTestData();
    vi.restoreAllMocks();
  });

  it('processes a single message successfully', async () => {
    const sendMessage = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const campaign = offerCampaignModel.createCampaign({ offerId: 'offer-1', totalRecipients: 1 });
    campaignMessageModel.createMessage({
      campaignId: campaign.id,
      clientId: 'client-1',
      phone: '201234567890',
      messageBody: 'Hello'
    });

    const result = await campaignWorker.processCampaignMessages(campaign.id);

    expect(result.succeeded).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith('201234567890', 'Hello');

    const updatedCampaign = offerCampaignModel.getCampaignById(campaign.id);
    expect(updatedCampaign.sentCount).toBe(1);
  });

  it('marks a message as failed when sendMessage fails', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: false, error: 'Blocked' });

    const campaign = offerCampaignModel.createCampaign({ offerId: 'offer-1', totalRecipients: 1 });
    campaignMessageModel.createMessage({
      campaignId: campaign.id,
      clientId: 'client-1',
      phone: '201234567890',
      messageBody: 'Hello'
    });

    const result = await campaignWorker.processCampaignMessages(campaign.id);

    expect(result.failed).toBe(1);

    const updatedMessage = campaignMessageModel.getMessageStats(campaign.id);
    expect(updatedMessage.failed).toBe(1);

    const updatedCampaign = offerCampaignModel.getCampaignById(campaign.id);
    expect(updatedCampaign.failedCount).toBe(1);
  });

  it('marks a message as failed when sendMessage throws', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockRejectedValue(new Error('Network error'));

    const campaign = offerCampaignModel.createCampaign({ offerId: 'offer-1', totalRecipients: 1 });
    campaignMessageModel.createMessage({
      campaignId: campaign.id,
      clientId: 'client-1',
      phone: '201234567890',
      messageBody: 'Hello'
    });

    const result = await campaignWorker.processCampaignMessages(campaign.id);

    expect(result.failed).toBe(1);
  });

  it('processes multiple messages in a campaign', async () => {
    const sendMessage = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const campaign = offerCampaignModel.createCampaign({ offerId: 'offer-1', totalRecipients: 2 });
    campaignMessageModel.bulkCreateMessages([
      { campaignId: campaign.id, clientId: 'client-1', phone: '201234567890', messageBody: 'One' },
      { campaignId: campaign.id, clientId: 'client-2', phone: '201000111222', messageBody: 'Two' }
    ]);

    const result = await campaignWorker.processCampaignMessages(campaign.id);

    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not start a worker interval in test mode', () => {
    expect(campaignWorker.isWorkerRunning()).toBe(false);
  });
});
