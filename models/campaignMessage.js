/**
 * Campaign Message Model
 * Handles individual messages within a campaign
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const CAMPAIGN_MESSAGES_FILE = path.join(DATA_DIR, 'campaignMessages.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize campaign messages file if it doesn't exist
if (!fs.existsSync(CAMPAIGN_MESSAGES_FILE)) {
    fs.writeFileSync(CAMPAIGN_MESSAGES_FILE, JSON.stringify([], null, 2));
}

function loadMessages() {
    try {
        const data = fs.readFileSync(CAMPAIGN_MESSAGES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function saveMessages(messages) {
    fs.writeFileSync(CAMPAIGN_MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

function getAllMessages() {
    return loadMessages();
}

function getMessageById(id) {
    const messages = loadMessages();
    return messages.find(m => m.id === id);
}

function getMessagesByCampaignId(campaignId) {
    const messages = loadMessages();
    return messages.filter(m => m.campaignId === campaignId);
}

function getMessagesByStatus(campaignId, status) {
    const messages = loadMessages();
    return messages.filter(m => m.campaignId === campaignId && m.status === status);
}

function createMessage(messageData) {
    const messages = loadMessages();
    
    // Validate status
    const validStatuses = ['pending', 'sent', 'failed'];
    const status = messageData.status || 'pending';
    if (!validStatuses.includes(status)) {
        throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
    
    const newMessage = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        campaignId: messageData.campaignId,
        clientId: messageData.clientId,
        phone: messageData.phone,
        messageBody: messageData.messageBody,
        status: status,
        sentAt: null,
        errorMessage: null,
        createdAt: new Date().toISOString()
    };
    
    messages.push(newMessage);
    saveMessages(messages);
    return newMessage;
}

function bulkCreateMessages(messagesData) {
    const messages = loadMessages();
    const validStatuses = ['pending', 'sent', 'failed'];
    
    const newMessages = messagesData.map(messageData => {
        const status = messageData.status || 'pending';
        if (!validStatuses.includes(status)) {
            throw new Error(`Invalid status: ${status}`);
        }
        
        return {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9) + Math.random().toString(36).substr(2, 3),
            campaignId: messageData.campaignId,
            clientId: messageData.clientId,
            phone: messageData.phone,
            messageBody: messageData.messageBody,
            status: status,
            sentAt: null,
            errorMessage: null,
            createdAt: new Date().toISOString()
        };
    });
    
    messages.push(...newMessages);
    saveMessages(messages);
    return newMessages;
}

function updateMessage(id, updates) {
    const messages = loadMessages();
    const index = messages.findIndex(m => m.id === id);
    
    if (index === -1) {
        return null;
    }
    
    // Validate status if provided
    if (updates.status) {
        const validStatuses = ['pending', 'sent', 'failed'];
        if (!validStatuses.includes(updates.status)) {
            throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        }
        
        // Set sentAt when status changes to 'sent'
        if (updates.status === 'sent' && !messages[index].sentAt) {
            updates.sentAt = new Date().toISOString();
        }
    }
    
    messages[index] = {
        ...messages[index],
        ...updates
    };
    
    saveMessages(messages);
    return messages[index];
}

function markAsSent(id) {
    return updateMessage(id, {
        status: 'sent',
        sentAt: new Date().toISOString()
    });
}

function markAsFailed(id, errorMessage) {
    return updateMessage(id, {
        status: 'failed',
        errorMessage: errorMessage || 'Unknown error'
    });
}

function deleteMessage(id) {
    const messages = loadMessages();
    const filtered = messages.filter(m => m.id !== id);
    saveMessages(filtered);
    return filtered.length < messages.length;
}

function deleteMessagesByCampaignId(campaignId) {
    const messages = loadMessages();
    const filtered = messages.filter(m => m.campaignId !== campaignId);
    saveMessages(filtered);
    return filtered.length < messages.length;
}

function getMessageStats(campaignId) {
    const messages = getMessagesByCampaignId(campaignId);
    
    return {
        total: messages.length,
        pending: messages.filter(m => m.status === 'pending').length,
        sent: messages.filter(m => m.status === 'sent').length,
        failed: messages.filter(m => m.status === 'failed').length
    };
}

function getAllPendingMessages() {
    const messages = loadMessages();
    return messages.filter(m => m.status === 'pending');
}

module.exports = {
    getAllMessages,
    getMessageById,
    getMessagesByCampaignId,
    getMessagesByStatus,
    getAllPendingMessages,
    createMessage,
    bulkCreateMessages,
    updateMessage,
    markAsSent,
    markAsFailed,
    deleteMessage,
    deleteMessagesByCampaignId,
    getMessageStats
};

