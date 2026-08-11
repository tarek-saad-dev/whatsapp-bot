const customerModel = require('../models/customer');

/**
 * Get customers who just purchased/took service right now
 * (within the last few minutes - considered "just now")
 */
function getJustNowCustomers() {
    const customers = customerModel.getAllCustomers();
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    
    return customers.filter(customer => {
        const purchaseDate = customer.lastPurchaseDate ? new Date(customer.lastPurchaseDate) : null;
        return purchaseDate && purchaseDate >= fiveMinutesAgo && purchaseDate <= now;
    });
}

/**
 * Get customers who purchased/visited today
 */
function getTodayCustomers() {
    const customers = customerModel.getAllCustomers();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    return customers.filter(customer => {
        const visitDate = customer.lastVisitDate ? new Date(customer.lastVisitDate) : null;
        const purchaseDate = customer.lastPurchaseDate ? new Date(customer.lastPurchaseDate) : null;
        
        const relevantDate = purchaseDate || visitDate;
        if (!relevantDate) return false;
        
        const date = new Date(relevantDate);
        date.setHours(0, 0, 0, 0);
        return date >= today && date < tomorrow;
    });
}

/**
 * Get customers who visited within this week
 */
function getThisWeekCustomers() {
    const customers = customerModel.getAllCustomers();
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
    startOfWeek.setHours(0, 0, 0, 0);
    
    return customers.filter(customer => {
        const visitDate = customer.lastVisitDate ? new Date(customer.lastVisitDate) : null;
        const purchaseDate = customer.lastPurchaseDate ? new Date(customer.lastPurchaseDate) : null;
        
        const relevantDate = purchaseDate || visitDate;
        if (!relevantDate) return false;
        
        return new Date(relevantDate) >= startOfWeek && new Date(relevantDate) <= now;
    });
}

/**
 * Get customers whose last visit was approximately 2 weeks ago
 * (between 12-16 days ago to account for flexibility)
 */
function getTwoWeeksAgoCustomers() {
    const customers = customerModel.getAllCustomers();
    const now = new Date();
    const twoWeeksAgo = new Date(now);
    twoWeeksAgo.setDate(now.getDate() - 14);
    
    const lowerBound = new Date(twoWeeksAgo);
    lowerBound.setDate(lowerBound.getDate() - 2); // 12 days ago
    lowerBound.setHours(0, 0, 0, 0);
    
    const upperBound = new Date(twoWeeksAgo);
    upperBound.setDate(upperBound.getDate() + 2); // 16 days ago
    upperBound.setHours(23, 59, 59, 999);
    
    return customers.filter(customer => {
        const visitDate = customer.lastVisitDate ? new Date(customer.lastVisitDate) : null;
        if (!visitDate) return false;
        
        const date = new Date(visitDate);
        return date >= lowerBound && date <= upperBound;
    });
}

/**
 * Get customers whose last visit was approximately one month ago
 * (between 28-32 days ago to account for flexibility)
 */
function getOneMonthAgoCustomers() {
    const customers = customerModel.getAllCustomers();
    const now = new Date();
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setDate(now.getDate() - 30);
    
    const lowerBound = new Date(oneMonthAgo);
    lowerBound.setDate(lowerBound.getDate() - 2); // 28 days ago
    lowerBound.setHours(0, 0, 0, 0);
    
    const upperBound = new Date(oneMonthAgo);
    upperBound.setDate(upperBound.getDate() + 2); // 32 days ago
    upperBound.setHours(23, 59, 59, 999);
    
    return customers.filter(customer => {
        const visitDate = customer.lastVisitDate ? new Date(customer.lastVisitDate) : null;
        if (!visitDate) return false;
        
        const date = new Date(visitDate);
        return date >= lowerBound && date <= upperBound;
    });
}

/**
 * Get customers for a specific segment type
 */
function getCustomersBySegment(segmentType) {
    switch (segmentType) {
        case 'just_now':
            return getJustNowCustomers();
        case 'today':
            return getTodayCustomers();
        case 'this_week':
            return getThisWeekCustomers();
        case 'two_weeks':
            return getTwoWeeksAgoCustomers();
        case 'one_month':
            return getOneMonthAgoCustomers();
        default:
            return [];
    }
}

/**
 * Get phone numbers for a specific segment type
 */
function getPhoneNumbersBySegment(segmentType) {
    const customers = getCustomersBySegment(segmentType);
    return customers.map(c => c.phone).filter(phone => phone);
}

module.exports = {
    getJustNowCustomers,
    getTodayCustomers,
    getThisWeekCustomers,
    getTwoWeeksAgoCustomers,
    getOneMonthAgoCustomers,
    getCustomersBySegment,
    getPhoneNumbersBySegment
};

