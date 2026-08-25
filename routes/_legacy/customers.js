/** @legacy-unused production campaign path — Phase 7 audience is ERP-owned (TblClient queries). This JSON customers API remains for legacy bot UI only. */
const express = require('express');
const router = express.Router();
const customerModel = require('../models/customer');

// Get all customers
router.get('/', (req, res) => {
    try {
        const customers = customerModel.getAllCustomers();
        res.json(customers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get a specific customer by phone
router.get('/:phone', (req, res) => {
    try {
        const customer = customerModel.getCustomerByPhone(req.params.phone);
        if (!customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        res.json(customer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create or update a customer
router.post('/', (req, res) => {
    try {
        const { phone, name, lastVisitDate, lastPurchaseDate } = req.body;
        
        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required' });
        }
        
        const customer = customerModel.addCustomer({
            phone: String(phone),
            name,
            lastVisitDate,
            lastPurchaseDate
        });
        
        res.status(201).json(customer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update a customer
router.put('/:phone', (req, res) => {
    try {
        const customer = customerModel.updateCustomer(req.params.phone, req.body);
        if (!customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        res.json(customer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a customer
router.delete('/:phone', (req, res) => {
    try {
        const deleted = customerModel.deleteCustomer(req.params.phone);
        if (!deleted) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        res.json({ message: 'Customer deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bulk import customers
router.post('/bulk-import', (req, res) => {
    try {
        const { customers } = req.body;
        
        if (!Array.isArray(customers)) {
            return res.status(400).json({ error: 'customers must be an array' });
        }
        
        const imported = customerModel.bulkImportCustomers(customers);
        res.status(201).json({
            message: `Imported ${imported.length} customers`,
            count: imported.length,
            customers: imported
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

