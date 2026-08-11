const express = require('express');
const router = express.Router();
const { renderTemplate } = require('../services/templateRenderer');
const {
    VALID_TYPES,
    DEFAULT_TEMPLATES,
    loadTemplates,
    saveTemplates,
    getTemplateString
} = require('../services/templateStorage');

/**
 * GET /api/templates
 * Get all templates
 */
router.get('/', (req, res) => {
    try {
        const templates = loadTemplates();
        res.json({ success: true, templates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/templates/:type
 * Get a specific template by type (sale or booking)
 */
router.get('/:type', (req, res) => {
    try {
        const templates = loadTemplates();
        const type = req.params.type;
        if (!templates[type] || !templates[type].template) {
            return res.status(404).json({ success: false, error: `Template '${type}' not found` });
        }
        res.json({
            success: true,
            type,
            template: templates[type].template,
            updatedAt: templates[type].updatedAt
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PUT /api/templates/:type
 * Update a specific template
 */
router.put('/:type', (req, res) => {
    try {
        const type = req.params.type;
        const { template, name } = req.body;

        if (!template || typeof template !== 'string' || template.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'Template content is required' });
        }

        if (!VALID_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: `type must be one of: ${VALID_TYPES.join(', ')}` });
        }

        const templates = loadTemplates();
        templates[type] = {
            name: name || templates[type]?.name || DEFAULT_TEMPLATES[type]?.name || type,
            template: template.trim(),
            updatedAt: new Date().toISOString()
        };

        saveTemplates(templates);
        console.log(`📝 Template '${type}' updated`);

        res.json({ success: true, type, template: templates[type].template, updatedAt: templates[type].updatedAt });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/templates/preview
 * Preview a template with sample data using the shared renderer
 */
router.post('/preview', (req, res) => {
    try {
        const { type, template, data } = req.body;
        const previewType = type || 'sale';

        if (!VALID_TYPES.includes(previewType)) {
            return res.status(400).json({ success: false, error: `type must be one of: ${VALID_TYPES.join(', ')}` });
        }

        const templateString = typeof template === 'string' && template.trim().length > 0
            ? template.trim()
            : getTemplateString(previewType);

        if (!templateString) {
            return res.status(404).json({ success: false, error: `Template '${previewType}' not found` });
        }

        const rendered = renderTemplate(templateString, data || {});
        res.json({ success: true, message: rendered });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

module.exports = router;
module.exports.loadTemplates = loadTemplates;
module.exports.getTemplateString = getTemplateString;
