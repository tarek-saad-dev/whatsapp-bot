'use strict';

const crypto = require('crypto');

/**
 * SHA-256 of normalized phone + trimmed final message.
 * Metadata is intentionally excluded so retries of the same delivery stay stable.
 */
function computeRequestHash(normalizedPhone, trimmedMessage) {
    const phone = String(normalizedPhone ?? '');
    const message = String(trimmedMessage ?? '');
    return crypto
        .createHash('sha256')
        .update(phone, 'utf8')
        .update('\n', 'utf8')
        .update(message, 'utf8')
        .digest('hex');
}

module.exports = {
    computeRequestHash,
};
