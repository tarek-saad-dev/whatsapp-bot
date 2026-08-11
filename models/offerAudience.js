const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const AUDIENCE_FILE = path.join(DATA_DIR, 'offerAudience.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize audience file if it doesn't exist
if (!fs.existsSync(AUDIENCE_FILE)) {
    fs.writeFileSync(AUDIENCE_FILE, JSON.stringify([], null, 2));
}

function loadAudience() {
    try {
        const data = fs.readFileSync(AUDIENCE_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function saveAudience(audience) {
    fs.writeFileSync(AUDIENCE_FILE, JSON.stringify(audience, null, 2));
}

function getAllAudience() {
    return loadAudience();
}

function getAudienceByOfferId(offerId) {
    const audience = loadAudience();
    return audience.filter(a => a.offerId === offerId);
}

function getAudienceById(id) {
    const audience = loadAudience();
    return audience.find(a => a.id === id);
}

function addAudienceMember(memberData) {
    const audience = loadAudience();
    
    // Check if this client is already in the audience for this offer
    const existing = audience.find(
        a => a.offerId === memberData.offerId && a.clientId === memberData.clientId
    );
    
    if (existing) {
        // Update existing entry
        existing.phone = memberData.phone;
        existing.matchedAt = new Date().toISOString();
        existing.updatedAt = new Date().toISOString();
        saveAudience(audience);
        return existing;
    }
    
    // Add new member
    const newMember = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        offerId: memberData.offerId,
        clientId: memberData.clientId,
        phone: memberData.phone,
        matchedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    audience.push(newMember);
    saveAudience(audience);
    return newMember;
}

function bulkAddAudienceMembers(members) {
    const audience = loadAudience();
    const existingMap = new Map();
    
    // Create a map of existing members for quick lookup
    audience.forEach(member => {
        const key = `${member.offerId}_${member.clientId}`;
        existingMap.set(key, member);
    });
    
    const added = [];
    const updated = [];
    
    members.forEach(memberData => {
        const key = `${memberData.offerId}_${memberData.clientId}`;
        const existing = existingMap.get(key);
        
        if (existing) {
            // Update existing
            existing.phone = memberData.phone;
            existing.matchedAt = new Date().toISOString();
            existing.updatedAt = new Date().toISOString();
            updated.push(existing);
        } else {
            // Add new
            const newMember = {
                id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                offerId: memberData.offerId,
                clientId: memberData.clientId,
                phone: memberData.phone,
                matchedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            audience.push(newMember);
            added.push(newMember);
        }
    });
    
    saveAudience(audience);
    return { added, updated, total: audience.length };
}

function deleteAudienceByOfferId(offerId) {
    const audience = loadAudience();
    const filtered = audience.filter(a => a.offerId !== offerId);
    saveAudience(filtered);
    return filtered.length < audience.length;
}

function deleteAudienceMember(id) {
    const audience = loadAudience();
    const filtered = audience.filter(a => a.id !== id);
    saveAudience(filtered);
    return filtered.length < audience.length;
}

function getAudienceCountByOfferId(offerId) {
    const audience = loadAudience();
    return audience.filter(a => a.offerId === offerId).length;
}

module.exports = {
    getAllAudience,
    getAudienceByOfferId,
    getAudienceById,
    addAudienceMember,
    bulkAddAudienceMembers,
    deleteAudienceByOfferId,
    deleteAudienceMember,
    getAudienceCountByOfferId
};



