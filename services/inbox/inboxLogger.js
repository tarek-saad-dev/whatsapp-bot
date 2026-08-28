'use strict';

function logInbox(event, fields = {}) {
    const payload = {
        ts: new Date().toISOString(),
        event,
        ...fields,
    };
    console.log(`[inbox] ${event}${formatFields(payload)}`);
}

function formatFields(payload) {
    const { ts, event, ...rest } = payload;
    const parts = Object.entries(rest)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => {
            if (key === 'text' && typeof value === 'string') {
                return `${key}=${JSON.stringify(value.slice(0, 80))}`;
            }
            return `${key}=${value}`;
        });
    return parts.length ? ` ${parts.join(' ')}` : '';
}

module.exports = {
    logInbox,
};
