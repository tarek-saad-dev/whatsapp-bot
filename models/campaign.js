const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize campaigns file if it doesn't exist
if (!fs.existsSync(CAMPAIGNS_FILE)) {
    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify([], null, 2));
}

function loadCampaigns() {
    try {
        const data = fs.readFileSync(CAMPAIGNS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function saveCampaigns(campaigns) {
    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2));
}

function getAllCampaigns() {
    return loadCampaigns();
}

function getCampaignById(id) {
    const campaigns = loadCampaigns();
    return campaigns.find(c => c.id === id);
}

function createCampaign(campaignData) {
    const campaigns = loadCampaigns();
    const newCampaign = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        name: campaignData.name,
        description: campaignData.description || '',
        messageTemplate: campaignData.messageTemplate || '',
        segmentType: campaignData.segmentType, // 'just_now', 'today', 'this_week', 'two_weeks', 'one_month'
        phoneNumbers: campaignData.phoneNumbers || [],
        status: campaignData.status || 'draft', // 'draft', 'active', 'completed', 'paused'
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastExecutedAt: null
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
    
    campaigns[index] = {
        ...campaigns[index],
        ...updates,
        updatedAt: new Date().toISOString()
    };
    
    saveCampaigns(campaigns);
    return campaigns[index];
}

function deleteCampaign(id) {
    const campaigns = loadCampaigns();
    const filtered = campaigns.filter(c => c.id !== id);
    saveCampaigns(filtered);
    return filtered.length < campaigns.length;
}

function updateCampaignPhoneNumbers(id, phoneNumbers) {
    const campaigns = loadCampaigns();
    const index = campaigns.findIndex(c => c.id === id);
    
    if (index === -1) {
        return null;
    }
    
    campaigns[index].phoneNumbers = phoneNumbers;
    campaigns[index].updatedAt = new Date().toISOString();
    
    saveCampaigns(campaigns);
    return campaigns[index];
}

module.exports = {
    getAllCampaigns,
    getCampaignById,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    updateCampaignPhoneNumbers
};

