const express = require('express');
const router = express.Router();
const offerModel = require('../models/offer');
const targetingRuleModel = require('../models/offerTargetingRule');
const audienceModel = require('../models/offerAudience');
const audienceBuilder = require('../services/offerAudienceBuilder');

// ============================================
// OFFER ROUTES
// ============================================

// Get all offers
router.get('/', (req, res) => {
    try {
        const offers = offerModel.getAllOffers();
        res.json(offers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// IMPORTANT: More specific routes must be defined BEFORE parameterized routes
// Get campaign summary for an offer (must be before /:id route)
router.get('/:id/summary', async (req, res) => {
    try {
        const offerId = req.params.id;
        
        // Get offer
        const offer = offerModel.getOfferById(offerId);
        if (!offer) {
            return res.status(404).json({ 
                error: 'Offer not found',
                message: `No offer found with ID: ${offerId}`
            });
        }
        
        // Get targeting rules
        const targetingRules = targetingRuleModel.getTargetingRulesByOfferId(offerId);
        
        // Get audience count
        const audienceCount = audienceModel.getAudienceCountByOfferId(offerId);
        
        // Get audience preview (3-5 records with names)
        let audiencePreview = [];
        if (audienceCount > 0) {
            const audienceMembers = audienceModel.getAudienceByOfferId(offerId);
            // Get preview with names from SQL Server
            try {
                audiencePreview = await audienceBuilder.getAudiencePreview(audienceMembers, 5);
            } catch (dbError) {
                console.warn('Could not fetch audience preview from database:', dbError.message);
                // Continue without preview if DB fails
                audiencePreview = audienceMembers.slice(0, 5).map(m => ({
                    name: 'Unknown',
                    phone: m.phone || ''
                }));
            }
        }
        
        // Generate message preview
        // Use first audience member name if available, otherwise use placeholder
        const sampleName = audiencePreview.length > 0 
            ? audiencePreview[0].name 
            : 'طارق سعد'; // Default sample name
        
        // Default WhatsApp message template
        const messagePreview = offer.formUrl
            ? `مرحباً ${sampleName}، لدينا عرض خاص لك! ${offer.name}. ${offer.description || ''} اضغط على الرابط للتسجيل: ${offer.formUrl}`
            : `مرحباً ${sampleName}، لدينا عرض خاص لك! ${offer.name}. ${offer.description || 'نتمنى أن ينال إعجابك.'}`;
        
        // Build response
        const response = {
            offer: {
                id: offer.id,
                name: offer.name,
                description: offer.description,
                status: offer.status,
                minAge: offer.minAge,
                maxAge: offer.maxAge,
                formUrl: offer.formUrl,
                createdAt: offer.createdAt,
                updatedAt: offer.updatedAt
            },
            targeting: targetingRules.map(rule => ({
                id: rule.id,
                gender: rule.gender,
                city: rule.city,
                maritalStatus: rule.maritalStatus,
                cameFrom: rule.cameFrom,
                lastVisitFrom: rule.lastVisitFrom,
                lastVisitTo: rule.lastVisitTo,
                minVisits: rule.minVisits,
                minSpend: rule.minSpend
            })),
            audienceCount: audienceCount,
            audiencePreview: audiencePreview,
            messagePreview: messagePreview
        };
        
        res.json(response);
    } catch (error) {
        console.error('Error getting offer summary:', error);
        res.status(500).json({ 
            error: error.message,
            message: 'Failed to generate offer summary'
        });
    }
});

// Get a specific offer
router.get('/:id', (req, res) => {
    try {
        const offer = offerModel.getOfferById(req.params.id);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        
        // Include targeting rules with the offer
        const targetingRules = targetingRuleModel.getTargetingRulesByOfferId(req.params.id);
        res.json({
            ...offer,
            targetingRules
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create a new offer
router.post('/', (req, res) => {
    try {
        const { name, description, minAge, maxAge, formUrl, status } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        
        const offer = offerModel.createOffer({
            name,
            description,
            minAge,
            maxAge,
            formUrl,
            status
        });
        
        res.status(201).json(offer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update an offer
router.put('/:id', (req, res) => {
    try {
        const offer = offerModel.updateOffer(req.params.id, req.body);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        res.json(offer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete an offer
router.delete('/:id', (req, res) => {
    try {
        // Also delete associated targeting rules
        targetingRuleModel.deleteTargetingRulesByOfferId(req.params.id);
        
        const deleted = offerModel.deleteOffer(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        res.json({ message: 'Offer and associated targeting rules deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// TARGETING RULES ROUTES
// ============================================

// Get all targeting rules for an offer
router.get('/:id/targeting', (req, res) => {
    try {
        const offer = offerModel.getOfferById(req.params.id);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        
        const rules = targetingRuleModel.getTargetingRulesByOfferId(req.params.id);
        res.json(rules);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create targeting rules for an offer
router.post('/:id/targeting', (req, res) => {
    try {
        const offerId = req.params.id;
        
        // Verify offer exists
        const offer = offerModel.getOfferById(offerId);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        
        const {
            gender,
            city,
            maritalStatus,
            cameFrom,
            lastVisitFrom,
            lastVisitTo,
            minVisits,
            minSpend
        } = req.body;
        
        const rule = targetingRuleModel.createTargetingRule({
            offerId,
            gender,
            city,
            maritalStatus,
            cameFrom,
            lastVisitFrom,
            lastVisitTo,
            minVisits,
            minSpend
        });
        
        res.status(201).json(rule);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update a specific targeting rule
router.put('/:id/targeting/:ruleId', (req, res) => {
    try {
        const offerId = req.params.id;
        const ruleId = req.params.ruleId;
        
        // Verify offer exists
        const offer = offerModel.getOfferById(offerId);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        
        // Verify rule exists and belongs to this offer
        const rule = targetingRuleModel.getTargetingRuleById(ruleId);
        if (!rule) {
            return res.status(404).json({ error: 'Targeting rule not found' });
        }
        
        if (rule.offerId !== offerId) {
            return res.status(400).json({ error: 'Targeting rule does not belong to this offer' });
        }
        
        const updated = targetingRuleModel.updateTargetingRule(ruleId, req.body);
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a specific targeting rule
router.delete('/:id/targeting/:ruleId', (req, res) => {
    try {
        const offerId = req.params.id;
        const ruleId = req.params.ruleId;
        
        // Verify offer exists
        const offer = offerModel.getOfferById(offerId);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        
        // Verify rule exists and belongs to this offer
        const rule = targetingRuleModel.getTargetingRuleById(ruleId);
        if (!rule) {
            return res.status(404).json({ error: 'Targeting rule not found' });
        }
        
        if (rule.offerId !== offerId) {
            return res.status(400).json({ error: 'Targeting rule does not belong to this offer' });
        }
        
        const deleted = targetingRuleModel.deleteTargetingRule(ruleId);
        if (!deleted) {
            return res.status(404).json({ error: 'Targeting rule not found' });
        }
        
        res.json({ message: 'Targeting rule deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// AUDIENCE ROUTES
// ============================================

// Build audience for an offer
router.post('/:id/build-audience', async (req, res) => {
    try {
        const offerId = req.params.id;
        
        // Verify offer exists
        const offer = offerModel.getOfferById(offerId);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        
        console.log(`🚀 Building audience for offer: ${offer.name} (${offerId})`);
        
        // Build audience
        const result = await audienceBuilder.buildOfferAudience(offerId);
        
        res.status(200).json({
            success: true,
            ...result,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error building audience:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Get audience for an offer
router.get('/:id/audience', (req, res) => {
    try {
        const offerId = req.params.id;
        
        // Verify offer exists
        const offer = offerModel.getOfferById(offerId);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        
        const audience = audienceModel.getAudienceByOfferId(offerId);
        const count = audience.length;
        
        res.json({
            offerId,
            offerName: offer.name,
            count,
            audience
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get audience count for an offer
router.get('/:id/audience/count', (req, res) => {
    try {
        const offerId = req.params.id;
        
        // Verify offer exists
        const offer = offerModel.getOfferById(offerId);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        
        const count = audienceModel.getAudienceCountByOfferId(offerId);
        
        res.json({
            offerId,
            offerName: offer.name,
            count
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete audience for an offer
router.delete('/:id/audience', (req, res) => {
    try {
        const offerId = req.params.id;
        
        // Verify offer exists
        const offer = offerModel.getOfferById(offerId);
        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }
        
        const deleted = audienceModel.deleteAudienceByOfferId(offerId);
        
        res.json({
            message: 'Audience deleted successfully',
            deleted
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

