import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as campaignMessageModel from '../../models/campaignMessage.js';
import * as offerCampaignModel from '../../models/offerCampaign.js';
import * as campaignWorker from '../../services/campaignWorker.js';
import * as whatsappService from '../../services/whatsappService.js';
import { resetTestData } from '../utils/test-helpers.js';

describe('Worker integration', () => {
  beforeEach(() => {
    resetTestData();
    vi.clearAllMocks();
  });

  it('processes all pending messages across campaigns', async () => {
    const sendMessage = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const campaignA = offerCampaignModel.createCampaign({ offerId: 'offer-a', totalRecipients: 2 });
    const campaignB = offerCampaignModel.createCampaign({ offerId: 'offer-b', totalRecipients: 1 });

    campaignMessageModel.bulkCreateMessages([
      { campaignId: campaignA.id, clientId: 'a1', phone: '201234567890', messageBody: 'A1' },
      { campaignId: campaignA.id, clientId: 'a2', phone: '201000111222', messageBody: 'A2' },
      { campaignId: campaignB.id, clientId: 'b1', phone: '201333444555', messageBody: 'B1' }
    ]);

    await campaignWorker.processPendingMessages();

    const statsA = campaignMessageModel.getMessageStats(campaignA.id);
    const statsB = campaignMessageModel.getMessageStats(campaignB.id);

    expect(statsA.pending).toBe(0);
    expect(statsA.sent).toBe(2);
    expect(statsB.pending).toBe(0);
    expect(statsB.sent).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(3);

    const updatedA = offerCampaignModel.getCampaignById(campaignA.id);
    const updatedB = offerCampaignModel.getCampaignById(campaignB.id);
    expect(updatedA.status).toBe('completed');
    expect(updatedB.status).toBe('completed');
  });
});
