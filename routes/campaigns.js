const express = require('express');
const router = express.Router();
const campaignModel = require('../models/campaign');
const offerCampaignModel = require('../models/offerCampaign');
const campaignMessageModel = require('../models/campaignMessage');
const offerModel = require('../models/offer');
const audienceModel = require('../models/offerAudience');
const customerModel = require('../models/customer');
const segmentationService = require('../services/segmentation');

// Get all campaigns
router.get('/', (req, res) => {
    try {
        const campaigns = campaignModel.getAllCampaigns();
        res.json(campaigns);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get a specific campaign
router.get('/:id', (req, res) => {
    try {
        const campaign = campaignModel.getCampaignById(req.params.id);
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        res.json(campaign);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create a new campaign
// Supports both segment-based campaigns (legacy) and offer-based campaigns (new)
router.post('/', async (req, res) => {
    try {
        const { offerId, name, description, messageTemplate, segmentType } = req.body;
        
        // IMPORTANT: Check for offerId FIRST - if provided, use offer-based flow
        // Do NOT require name/segmentType when offerId is provided
        // Check explicitly for truthy value (not null, undefined, or empty string)
        const hasOfferId = offerId !== undefined && offerId !== null && offerId !== '';
        
        // Debug logging (can be removed later)
        console.log('POST /api/campaigns - Request body:', { offerId, hasOfferId, name, segmentType });
        
        if (hasOfferId) {
            console.log('✅ Using offer-based campaign flow for offerId:', offerId);
            // Validate that the offer exists
            const offer = offerModel.getOfferById(offerId);
            if (!offer) {
                return res.status(404).json({ 
                    error: 'Offer not found',
                    message: `No offer found with ID: ${offerId}`
                });
            }
            
            // Get total recipients from OfferAudience
            const totalRecipients = audienceModel.getAudienceCountByOfferId(offerId);
            
            // Allow campaigns with 0 recipients for development/testing
            // In production, you may want to add validation here
            if (totalRecipients === 0) {
                console.warn(`⚠️  Warning: Creating campaign with 0 recipients for offer ${offerId}`);
                console.warn('   This is allowed in development. Consider building audience first.');
            }
            
            // Create the campaign (even with 0 recipients)
            const campaign = offerCampaignModel.createCampaign({
                offerId: offerId,
                status: 'draft',
                totalRecipients: totalRecipients
            });
            
            // Get audience members
            const audienceMembers = audienceModel.getAudienceByOfferId(offerId);
            
            let createdMessages = [];
            
            // Only create messages if there are recipients
            if (totalRecipients > 0 && audienceMembers.length > 0) {
                // Generate message body from offer
                const messageBody = offer.formUrl
                    ? `مرحباً، لدينا عرض خاص لك! ${offer.name}. ${offer.description || ''} اضغط على الرابط للتسجيل: ${offer.formUrl}`
                    : `مرحباً، لدينا عرض خاص لك! ${offer.name}. ${offer.description || 'نتمنى أن ينال إعجابك.'}`;
                
                // Create campaign messages for each audience member
                const messagesData = audienceMembers.map(member => ({
                    campaignId: campaign.id,
                    clientId: member.clientId,
                    phone: member.phone,
                    messageBody: messageBody,
                    status: 'pending'
                }));
                
                // Bulk create messages
                createdMessages = campaignMessageModel.bulkCreateMessages(messagesData);
            } else {
                console.log(`ℹ️  No messages created - campaign has 0 recipients`);
            }
            
            if (createdMessages.length > 0) {
                console.log(`✅ Created campaign ${campaign.id} with ${createdMessages.length} messages`);
            } else {
                console.log(`✅ Created campaign ${campaign.id} with 0 messages (no recipients)`);
            }
            
            res.status(201).json({
                ...campaign,
                messagesCreated: createdMessages.length,
                warning: totalRecipients === 0 ? 'Campaign created with 0 recipients. Build audience first to add recipients.' : undefined
            });
            
        } else {
            // Legacy segment-based campaign creation
            // Only validate name/segmentType when offerId is NOT provided
            console.log('⚠️  Using segment-based campaign flow (no offerId provided)');
            if (!name || !segmentType) {
                return res.status(400).json({ 
                    error: 'Name and segmentType are required for segment-based campaigns',
                    message: 'For offer-based campaigns, provide offerId instead'
                });
            }
            
            // Get phone numbers for this segment
            const phoneNumbers = segmentationService.getPhoneNumbersBySegment(segmentType);
            
            const campaign = campaignModel.createCampaign({
                name,
                description,
                messageTemplate,
                segmentType,
                phoneNumbers
            });
            
            res.status(201).json(campaign);
        }
    } catch (error) {
        console.error('Error creating campaign:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update a campaign
router.put('/:id', (req, res) => {
    try {
        const campaign = campaignModel.updateCampaign(req.params.id, req.body);
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        res.json(campaign);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a campaign
router.delete('/:id', (req, res) => {
    try {
        const deleted = campaignModel.deleteCampaign(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        res.json({ message: 'Campaign deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Refresh phone numbers for a campaign (recalculate segment)
router.post('/:id/refresh', (req, res) => {
    try {
        const campaign = campaignModel.getCampaignById(req.params.id);
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        const phoneNumbers = segmentationService.getPhoneNumbersBySegment(campaign.segmentType);
        const updated = campaignModel.updateCampaignPhoneNumbers(req.params.id, phoneNumbers);
        
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get preview of customers for a segment type
router.get('/preview/:segmentType', (req, res) => {
    try {
        const { segmentType } = req.params;
        const customers = segmentationService.getCustomersBySegment(segmentType);
        res.json({
            segmentType,
            count: customers.length,
            customers: customers.map(c => ({
                phone: c.phone,
                name: c.name,
                lastVisitDate: c.lastVisitDate,
                lastPurchaseDate: c.lastPurchaseDate
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Execute a campaign (triggers WhatsApp bot)
router.post('/:id/execute', async (req, res) => {
    try {
        const campaign = campaignModel.getCampaignById(req.params.id);
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        if (campaign.phoneNumbers.length === 0) {
            return res.status(400).json({ error: 'Campaign has no customers' });
        }
        
        // Return execution data - actual execution can be triggered separately
        // or you can use a job queue system
        const campaignExecutor = require('../services/campaignExecutor');
        const executionData = campaignExecutor.getCampaignExecutionData(req.params.id);
        
        res.json({
            message: 'Campaign execution started',
            campaignId: executionData.campaignId,
            campaignName: executionData.campaignName,
            totalMessages: executionData.totalCount,
            note: 'To actually send messages, run: node bot-campaign.js ' + req.params.id
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// OFFER-BASED CAMPAIGN ROUTES
// ============================================

// Get all offer-based campaigns
router.get('/offers', (req, res) => {
    try {
        const campaigns = offerCampaignModel.getAllCampaigns();
        res.json(campaigns);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get a specific offer-based campaign
router.get('/offers/:id', (req, res) => {
    try {
        const campaign = offerCampaignModel.getCampaignById(req.params.id);
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        // Get message stats
        const messageStats = campaignMessageModel.getMessageStats(req.params.id);
        
        res.json({
            ...campaign,
            messageStats
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get campaigns by offer ID
router.get('/offers/by-offer/:offerId', (req, res) => {
    try {
        const campaigns = offerCampaignModel.getCampaignsByOfferId(req.params.offerId);
        res.json(campaigns);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get campaign messages
router.get('/offers/:id/messages', (req, res) => {
    try {
        const campaignId = req.params.id;
        const { status } = req.query;
        
        // Verify campaign exists
        const campaign = offerCampaignModel.getCampaignById(campaignId);
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        let messages;
        if (status) {
            messages = campaignMessageModel.getMessagesByStatus(campaignId, status);
        } else {
            messages = campaignMessageModel.getMessagesByCampaignId(campaignId);
        }
        
        res.json({
            campaignId,
            count: messages.length,
            messages
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get campaign message statistics
router.get('/offers/:id/stats', (req, res) => {
    try {
        const campaignId = req.params.id;
        
        // Verify campaign exists
        const campaign = offerCampaignModel.getCampaignById(campaignId);
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        const messageStats = campaignMessageModel.getMessageStats(campaignId);
        
        res.json({
            campaignId,
            campaign: {
                id: campaign.id,
                offerId: campaign.offerId,
                status: campaign.status,
                totalRecipients: campaign.totalRecipients,
                sentCount: campaign.sentCount,
                failedCount: campaign.failedCount
            },
            messages: messageStats
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update campaign status
router.put('/offers/:id', (req, res) => {
    try {
        const campaign = offerCampaignModel.updateCampaign(req.params.id, req.body);
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        res.json(campaign);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete offer-based campaign
router.delete('/offers/:id', (req, res) => {
    try {
        // Delete associated messages first
        campaignMessageModel.deleteMessagesByCampaignId(req.params.id);
        
        const deleted = offerCampaignModel.deleteCampaign(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        res.json({ 
            message: 'Campaign and associated messages deleted successfully',
            deleted: true
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start campaign (queue messages for sending)
router.post('/offers/:id/start', async (req, res) => {
    try {
        const campaignId = req.params.id;
        
        // Verify campaign exists
        const campaign = offerCampaignModel.getCampaignById(campaignId);
        if (!campaign) {
            return res.status(404).json({ 
                error: 'Campaign not found',
                message: `No campaign found with ID: ${campaignId}`
            });
        }
        
        // Check if campaign is already started/completed
        if (campaign.status === 'sending' || campaign.status === 'completed') {
            return res.status(400).json({
                error: 'Campaign already started',
                message: `Campaign is already in status: ${campaign.status}`
            });
        }
        
        // Get existing messages for this campaign
        let existingMessages = campaignMessageModel.getMessagesByCampaignId(campaignId);
        
        // If no messages exist, create them from audience
        if (existingMessages.length === 0) {
            console.log(`ℹ️  No messages found for campaign ${campaignId}, creating from audience...`);
            
            // Get offer
            const offer = offerModel.getOfferById(campaign.offerId);
            if (!offer) {
                return res.status(404).json({
                    error: 'Offer not found',
                    message: `Offer ${campaign.offerId} associated with this campaign was not found`
                });
            }
            
            // Get audience members
            let audienceMembers = audienceModel.getAudienceByOfferId(campaign.offerId);
            
            // If no audience exists, try to build it automatically
            if (audienceMembers.length === 0) {
                console.log(`ℹ️  No audience found for offer ${campaign.offerId}, attempting to build...`);
                
                try {
                    const audienceBuilder = require('../services/offerAudienceBuilder');
                    const buildResult = await audienceBuilder.buildOfferAudience(campaign.offerId);
                    
                    console.log(`✅ Audience built: ${buildResult.audienceCount} members`);
                    
                    // Get the newly built audience
                    audienceMembers = audienceModel.getAudienceByOfferId(campaign.offerId);
                    
                    // If still 0 after building, return error
                    if (audienceMembers.length === 0) {
                        return res.status(400).json({
                            error: 'No audience found',
                            message: 'Audience was built but no clients matched the targeting criteria. Please adjust targeting rules or ensure database has matching data.',
                            audienceCount: 0
                        });
                    }
                } catch (buildError) {
                    console.error('❌ Error building audience:', buildError);
                    return res.status(500).json({
                        error: 'Failed to build audience',
                        message: buildError.message || 'Error building audience from database',
                        details: 'Please try building audience manually using POST /api/offers/:id/build-audience'
                    });
                }
            }
            
            // Generate message body from offer
            const messageBody = offer.formUrl
                ? `مرحباً، لدينا عرض خاص لك! ${offer.name}. ${offer.description || ''} اضغط على الرابط للتسجيل: ${offer.formUrl}`
                : `مرحباً، لدينا عرض خاص لك! ${offer.name}. ${offer.description || 'نتمنى أن ينال إعجابك.'}`;
            
            // Create campaign messages for each audience member
            const messagesData = audienceMembers.map(member => ({
                campaignId: campaignId,
                clientId: member.clientId,
                phone: member.phone,
                messageBody: messageBody,
                status: 'pending'
            }));
            
            // Bulk create messages
            existingMessages = campaignMessageModel.bulkCreateMessages(messagesData);
            
            // Update totalRecipients if it was 0
            if (campaign.totalRecipients === 0) {
                offerCampaignModel.updateCampaign(campaignId, {
                    totalRecipients: existingMessages.length
                });
            }
            
            console.log(`✅ Created ${existingMessages.length} messages for campaign ${campaignId}`);
        }
        
        // Update campaign status to 'sending' and set startedAt
        const updatedCampaign = offerCampaignModel.updateCampaign(campaignId, {
            status: 'sending'
        });
        
        // Get message stats
        const messageStats = campaignMessageModel.getMessageStats(campaignId);
        
        console.log(`🚀 Campaign ${campaignId} started with ${messageStats.pending} pending messages`);
        
        res.json({
            success: true,
            campaign: updatedCampaign,
            messages: {
                total: messageStats.total,
                pending: messageStats.pending,
                sent: messageStats.sent,
                failed: messageStats.failed
            },
            message: 'Campaign started. Messages will be processed by the worker.'
        });
        
    } catch (error) {
        console.error('Error starting campaign:', error);
        res.status(500).json({ 
            error: error.message,
            message: 'Failed to start campaign'
        });
    }
});

module.exports = router;

