'use strict';

const EGYPT_MOBILE_REGEX = /^20(10|11|12|15)\d{8}$/;

/**
 * Normalize an Egyptian mobile number to international digits (no +).
 * 01039244023 → 201039244023
 * 01227423337 → 201227423337
 */
function normalizeEgyptianPhone(phone) {
  if (phone === null || phone === undefined) {
    return null;
  }

  let cleaned = phone.toString().trim();
  cleaned = cleaned.replace(/[\s\-+().]/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = cleaned.slice(2);
  }

  if (cleaned.startsWith('0')) {
    cleaned = '20' + cleaned.slice(1);
  }

  if (/^(10|11|12|15)\d{8}$/.test(cleaned)) {
    cleaned = '20' + cleaned;
  }

  return EGYPT_MOBILE_REGEX.test(cleaned) ? cleaned : null;
}

function chatIdFromNormalizedPhone(normalizedPhone) {
  const digits = String(normalizedPhone || '').replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@c.us`;
}

module.exports = {
  EGYPT_MOBILE_REGEX,
  normalizeEgyptianPhone,
  chatIdFromNormalizedPhone,
};
