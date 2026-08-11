const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize customers file if it doesn't exist
if (!fs.existsSync(CUSTOMERS_FILE)) {
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify([], null, 2));
}

function loadCustomers() {
    try {
        const data = fs.readFileSync(CUSTOMERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function saveCustomers(customers) {
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2));
}

function getAllCustomers() {
    return loadCustomers();
}

function getCustomerByPhone(phone) {
    const customers = loadCustomers();
    return customers.find(c => c.phone === phone);
}

function addCustomer(customer) {
    const customers = loadCustomers();
    const existing = customers.find(c => c.phone === customer.phone);
    
    if (existing) {
        // Update existing customer
        Object.assign(existing, customer);
    } else {
        // Add new customer
        customers.push({
            id: Date.now().toString(),
            phone: customer.phone,
            name: customer.name || '',
            lastVisitDate: customer.lastVisitDate || null,
            lastPurchaseDate: customer.lastPurchaseDate || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }
    
    saveCustomers(customers);
    return existing ? existing : customers[customers.length - 1];
}

function updateCustomer(phone, updates) {
    const customers = loadCustomers();
    const index = customers.findIndex(c => c.phone === phone);
    
    if (index === -1) {
        return null;
    }
    
    customers[index] = {
        ...customers[index],
        ...updates,
        updatedAt: new Date().toISOString()
    };
    
    saveCustomers(customers);
    return customers[index];
}

function deleteCustomer(phone) {
    const customers = loadCustomers();
    const filtered = customers.filter(c => c.phone !== phone);
    saveCustomers(filtered);
    return filtered.length < customers.length;
}

function bulkImportCustomers(customersData) {
    const existing = loadCustomers();
    const phoneMap = new Map(existing.map(c => [c.phone, c]));
    
    customersData.forEach(customer => {
        const phone = String(customer.phone).trim();
        if (phone) {
            const existingCustomer = phoneMap.get(phone);
            if (existingCustomer) {
                // Update existing
                Object.assign(existingCustomer, {
                    name: customer.name || existingCustomer.name,
                    lastVisitDate: customer.lastVisitDate || existingCustomer.lastVisitDate,
                    lastPurchaseDate: customer.lastPurchaseDate || existingCustomer.lastPurchaseDate,
                    updatedAt: new Date().toISOString()
                });
            } else {
                // Add new
                phoneMap.set(phone, {
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                    phone: phone,
                    name: customer.name || '',
                    lastVisitDate: customer.lastVisitDate || null,
                    lastPurchaseDate: customer.lastPurchaseDate || null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            }
        }
    });
    
    saveCustomers(Array.from(phoneMap.values()));
    return Array.from(phoneMap.values());
}

module.exports = {
    getAllCustomers,
    getCustomerByPhone,
    addCustomer,
    updateCustomer,
    deleteCustomer,
    bulkImportCustomers
};

