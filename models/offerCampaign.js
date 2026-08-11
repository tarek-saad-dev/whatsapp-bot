/**
 * Offer-Based Campaign Model
 * Handles campaigns created from offers (different from segment-based campaigns)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const OFFER_CAMPAIGNS_FILE = path.join(DATA_DIR, 'offerCampaigns.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize offer campaigns file if it doesn't exist
if (!fs.existsSync(OFFER_CAMPAIGNS_FILE)) {
    fs.writeFileSync(OFFER_CAMPAIGNS_FILE, JSON.stringify([], null, 2));
}

function loadCampaigns() {
    try {
        const data = fs.readFileSync(OFFER_CAMPAIGNS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function saveCampaigns(campaigns) {
    fs.writeFileSync(OFFER_CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2));
}

function getAllCampaigns() {
    return loadCampaigns();
}

function getCampaignById(id) {
    const campaigns = loadCampaigns();
    return campaigns.find(c => c.id === id);
}

function getCampaignsByOfferId(offerId) {
    const campaigns = loadCampaigns();
    return campaigns.filter(c => c.offerId === offerId);
}

function createCampaign(campaignData) {
    const campaigns = loadCampaigns();
    
    // Validate status
    const validStatuses = ['draft', 'approved', 'sending', 'completed'];
    const status = campaignData.status || 'draft';
    if (!validStatuses.includes(status)) {
        throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
    
    const newCampaign = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        offerId: campaignData.offerId,
        status: status,
        totalRecipients: campaignData.totalRecipients || 0,
        sentCount: 0,
        failedCount: 0,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null
    };
    
    campaigns.push(newCampaign);
    saveCampaigns(campaigns);
    return newCampaign;
}

function updateCampaign(id, updates) {
    const campaigns = loadCampaigns();
    const index = campaigns.findIndex(c => c.id === id);
    
    if (index === -1) {
        return null;
    }
    
    // Validate status if provided
    if (updates.status) {
        const validStatuses = ['draft', 'approved', 'sending', 'completed'];
        if (!validStatuses.includes(updates.status)) {
            throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        }
    }
    
    // Handle status transitions
    if (updates.status === 'sending' && !campaigns[index].startedAt) {
        updates.startedAt = new Date().toISOString();
    }
    
    if (updates.status === 'completed' && !campaigns[index].completedAt) {
        updates.completedAt = new Date().toISOString();
    }
    
    campaigns[index] = {
        ...campaigns[index],
        ...updates
    };
    
    saveCampaigns(campaigns);
    return campaigns[index];
}

function incrementSentCount(id) {
    const campaigns = loadCampaigns();
    const index = campaigns.findIndex(c => c.id === id);
    
    if (index === -1) {
        return null;
    }
    
    campaigns[index].sentCount = (campaigns[index].sentCount || 0) + 1;
    saveCampaigns(campaigns);
    return campaigns[index];
}

function incrementFailedCount(id) {
    const campaigns = loadCampaigns();
    const index = campaigns.findIndex(c => c.id === id);
    
    if (index === -1) {
        return null;
    }
    
    campaigns[index].failedCount = (campaigns[index].failedCount || 0) + 1;
    saveCampaigns(campaigns);
    return campaigns[index];
}

function deleteCampaign(id) {
    const campaigns = loadCampaigns();
    const filtered = campaigns.filter(c => c.id !== id);
    saveCampaigns(filtered);
    return filtered.length < campaigns.length;
}

module.exports = {
    getAllCampaigns,
    getCampaignById,
    getCampaignsByOfferId,
    createCampaign,
    updateCampaign,
    incrementSentCount,
    incrementFailedCount,
    deleteCampaign
};

