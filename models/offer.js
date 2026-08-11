const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const OFFERS_FILE = path.join(DATA_DIR, 'offers.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize offers file if it doesn't exist
if (!fs.existsSync(OFFERS_FILE)) {
    fs.writeFileSync(OFFERS_FILE, JSON.stringify([], null, 2));
}

function loadOffers() {
    try {
        const data = fs.readFileSync(OFFERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function saveOffers(offers) {
    fs.writeFileSync(OFFERS_FILE, JSON.stringify(offers, null, 2));
}

function getAllOffers() {
    return loadOffers();
}

function getOfferById(id) {
    const offers = loadOffers();
    return offers.find(o => o.id === id);
}

function createOffer(offerData) {
    const offers = loadOffers();
    const newOffer = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        name: offerData.name,
        description: offerData.description || '',
        minAge: offerData.minAge !== undefined ? parseInt(offerData.minAge) : null,
        maxAge: offerData.maxAge !== undefined ? parseInt(offerData.maxAge) : null,
        formUrl: offerData.formUrl || null,
        status: offerData.status || 'draft', // 'draft', 'active', 'expired'
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    // Validate status
    const validStatuses = ['draft', 'active', 'expired'];
    if (!validStatuses.includes(newOffer.status)) {
        throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
    
    offers.push(newOffer);
    saveOffers(offers);
    return newOffer;
}

function updateOffer(id, updates) {
    const offers = loadOffers();
    const index = offers.findIndex(o => o.id === id);
    
    if (index === -1) {
        return null;
    }
    
    // Validate status if provided
    if (updates.status) {
        const validStatuses = ['draft', 'active', 'expired'];
        if (!validStatuses.includes(updates.status)) {
            throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        }
    }
    
    // Update fields
    const updatedOffer = {
        ...offers[index],
        ...updates,
        updatedAt: new Date().toISOString()
    };
    
    // Ensure numeric fields are properly converted
    if (updates.minAge !== undefined) {
        updatedOffer.minAge = updates.minAge !== null ? parseInt(updates.minAge) : null;
    }
    if (updates.maxAge !== undefined) {
        updatedOffer.maxAge = updates.maxAge !== null ? parseInt(updates.maxAge) : null;
    }
    
    offers[index] = updatedOffer;
    saveOffers(offers);
    return offers[index];
}

function deleteOffer(id) {
    const offers = loadOffers();
    const filtered = offers.filter(o => o.id !== id);
    saveOffers(filtered);
    return filtered.length < offers.length;
}

module.exports = {
    getAllOffers,
    getOfferById,
    createOffer,
    updateOffer,
    deleteOffer
};



