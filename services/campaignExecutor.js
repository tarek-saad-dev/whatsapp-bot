const campaignModel = require('../models/campaign');
const customerModel = require('../models/customer');

/**
 * Prepare campaign data for execution
 * This formats the message template with customer data
 */
function prepareCampaignMessages(campaign) {
    const messages = [];
    
    campaign.phoneNumbers.forEach(phone => {
        const customer = customerModel.getCustomerByPhone(phone);
        let message = campaign.messageTemplate;
        
        // Replace template variables
        if (customer) {
            message = message.replace(/\{\{name\}\}/g, customer.name || 'Customer');
        } else {
            message = message.replace(/\{\{name\}\}/g, 'Customer');
        }
        
        messages.push({
            phone: phone,
            message: message
        });
    });
    
    return messages;
}

/**
 * Get campaign execution data
 */
function getCampaignExecutionData(campaignId) {
    const campaign = campaignModel.getCampaignById(campaignId);
    
    if (!campaign) {
        throw new Error('Campaign not found');
    }
    
    if (campaign.phoneNumbers.length === 0) {
        throw new Error('Campaign has no customers');
    }
    
    const messages = prepareCampaignMessages(campaign);
    
    // Update campaign last executed timestamp
    campaignModel.updateCampaign(campaignId, {
        lastExecutedAt: new Date().toISOString(),
        status: 'active'
    });
    
    return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        messages: messages,
        totalCount: messages.length
    };
}

module.exports = {
    prepareCampaignMessages,
    getCampaignExecutionData
};

