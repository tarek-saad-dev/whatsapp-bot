const ARABIC_COMMA = '،';

const REQUIRED_VARIABLES = ['customerName'];

// Map variable name -> list of possible data keys (canonical first)
const ALIAS_MAP = {
    customerName: ['customerName'],
    phone: ['phone'],
    invoiceNumber: ['invoiceNumber', 'orderId'],
    orderId: ['orderId', 'invoiceNumber'],
    total: ['total', 'amount'],
    amount: ['amount', 'total'],
    currency: ['currency'],
    paymentMethod: ['paymentMethod'],
    bookingId: ['bookingId', 'orderId'],
    bookingDate: ['bookingDate', 'date'],
    date: ['date', 'bookingDate'],
    bookingTime: ['bookingTime', 'time'],
    time: ['time', 'bookingTime'],
    services: ['services', 'service'],
    service: ['service', 'services'],
    employeeName: ['employeeName', 'barberName'],
    barberName: ['barberName', 'employeeName'],
    branchName: ['branchName'],
    bookingLink: ['bookingLink'],
    notes: ['notes'],
    items: ['items'],
    workDate: ['workDate', 'date'],
    checkIn: ['checkIn'],
    checkOut: ['checkOut'],
    actualHours: ['actualHours'],
    scheduledHours: ['scheduledHours'],
    statusLabelAr: ['statusLabelAr'],
    lateMinutes: ['lateMinutes'],
    baseWage: ['baseWage'],
    fullDayBase: ['fullDayBase'],
    baseWageNoteAr: ['baseWageNoteAr'],
    targetSales: ['targetSales'],
    targetAmount: ['targetAmount'],
    deductions: ['deductions'],
    advances: ['advances'],
    dayNet: ['dayNet'],
    ledgerBalance: ['ledgerBalance'],
    payrollMonth: ['payrollMonth']
};

function hasValue(value) {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    return String(value).trim().length > 0;
}

function formatValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        return value
            .filter(item => hasValue(item))
            .map(item => String(item).trim())
            .join(`${ARABIC_COMMA} `);
    }
    return String(value).trim();
}

function resolveValue(data, variable) {
    const keys = ALIAS_MAP[variable];
    if (!keys) return undefined;
    for (const key of keys) {
        if (hasValue(data[key])) {
            return formatValue(data[key]);
        }
    }
    return undefined;
}

function removeLinesContainingPlaceholder(text, placeholder) {
    const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`);
    return text
        .split('\n')
        .filter(line => !regex.test(line))
        .join('\n');
}

function cleanBlankLines(text) {
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

function renderTemplate(template, data) {
    if (!template || typeof template !== 'string' || template.trim().length === 0) {
        throw new Error('Template is required');
    }

    // Required fields
    for (const required of REQUIRED_VARIABLES) {
        if (!hasValue(data[required])) {
            throw new Error(`${required} is required`);
        }
    }

    // Extract all unique placeholder names from the template
    const placeholderRegex = /\{\{\s*([\w]+)\s*\}\}/g;
    const placeholders = new Set();
    let match;
    while ((match = placeholderRegex.exec(template)) !== null) {
        placeholders.add(match[1]);
    }

    let message = template;

    // First pass: replace placeholders that have values
    for (const placeholder of placeholders) {
        const value = resolveValue(data, placeholder);
        if (hasValue(value)) {
            const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, 'g');
            message = message.replace(regex, value);
        }
    }

    // Second pass: remove lines containing unresolved placeholders
    for (const placeholder of placeholders) {
        const value = resolveValue(data, placeholder);
        if (!hasValue(value)) {
            message = removeLinesContainingPlaceholder(message, placeholder);
        }
    }

    // Clean excessive blank lines
    message = cleanBlankLines(message);

    // Final check for any remaining raw placeholders
    if (/\{\{\s*[\w]+\s*\}\}/.test(message)) {
        throw new Error('Template contains unresolved placeholders');
    }

    return message;
}

module.exports = { renderTemplate, hasValue, ARABIC_COMMA };
