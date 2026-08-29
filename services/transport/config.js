'use strict';

const VALID_TRANSPORTS = ['selenium', 'baileys'];

function getTransportMode() {
    const raw = String(process.env.WHATSAPP_TRANSPORT || 'selenium').trim().toLowerCase();
    if (!VALID_TRANSPORTS.includes(raw)) {
        throw new Error(
            `Invalid WHATSAPP_TRANSPORT="${raw}". Expected one of: ${VALID_TRANSPORTS.join(', ')}`,
        );
    }
    return raw;
}

function isBaileysTransport() {
    return getTransportMode() === 'baileys';
}

function isSeleniumTransport() {
    return getTransportMode() === 'selenium';
}

module.exports = {
    VALID_TRANSPORTS,
    getTransportMode,
    isBaileysTransport,
    isSeleniumTransport,
};
