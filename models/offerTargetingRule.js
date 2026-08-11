const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const TARGETING_RULES_FILE = path.join(DATA_DIR, 'offerTargetingRules.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize targeting rules file if it doesn't exist
if (!fs.existsSync(TARGETING_RULES_FILE)) {
    fs.writeFileSync(TARGETING_RULES_FILE, JSON.stringify([], null, 2));
}

function loadTargetingRules() {
    try {
        const data = fs.readFileSync(TARGETING_RULES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function saveTargetingRules(rules) {
    fs.writeFileSync(TARGETING_RULES_FILE, JSON.stringify(rules, null, 2));
}

function getAllTargetingRules() {
    return loadTargetingRules();
}

function getTargetingRuleById(id) {
    const rules = loadTargetingRules();
    return rules.find(r => r.id === id);
}

function getTargetingRulesByOfferId(offerId) {
    const rules = loadTargetingRules();
    return rules.filter(r => r.offerId === offerId);
}

function createTargetingRule(ruleData) {
    const rules = loadTargetingRules();
    
    // Check if offer already has targeting rules (optional: allow only one rule per offer)
    // For now, we allow multiple rules per offer
    
    const newRule = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        offerId: ruleData.offerId,
        gender: ruleData.gender || null,
        city: ruleData.city || null,
        maritalStatus: ruleData.maritalStatus || null,
        cameFrom: ruleData.cameFrom || null,
        lastVisitFrom: ruleData.lastVisitFrom || null,
        lastVisitTo: ruleData.lastVisitTo || null,
        minVisits: ruleData.minVisits !== undefined ? parseInt(ruleData.minVisits) : null,
        minSpend: ruleData.minSpend !== undefined ? parseFloat(ruleData.minSpend) : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    rules.push(newRule);
    saveTargetingRules(rules);
    return newRule;
}

function updateTargetingRule(id, updates) {
    const rules = loadTargetingRules();
    const index = rules.findIndex(r => r.id === id);
    
    if (index === -1) {
        return null;
    }
    
    const updatedRule = {
        ...rules[index],
        ...updates,
        updatedAt: new Date().toISOString()
    };
    
    // Ensure numeric fields are properly converted
    if (updates.minVisits !== undefined) {
        updatedRule.minVisits = updates.minVisits !== null ? parseInt(updates.minVisits) : null;
    }
    if (updates.minSpend !== undefined) {
        updatedRule.minSpend = updates.minSpend !== null ? parseFloat(updates.minSpend) : null;
    }
    
    rules[index] = updatedRule;
    saveTargetingRules(rules);
    return rules[index];
}

function deleteTargetingRule(id) {
    const rules = loadTargetingRules();
    const filtered = rules.filter(r => r.id !== id);
    saveTargetingRules(filtered);
    return filtered.length < rules.length;
}

function deleteTargetingRulesByOfferId(offerId) {
    const rules = loadTargetingRules();
    const filtered = rules.filter(r => r.offerId !== offerId);
    saveTargetingRules(filtered);
    return filtered.length < rules.length;
}

module.exports = {
    getAllTargetingRules,
    getTargetingRuleById,
    getTargetingRulesByOfferId,
    createTargetingRule,
    updateTargetingRule,
    deleteTargetingRule,
    deleteTargetingRulesByOfferId
};



