'use strict';

const ACCOUNT_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Validate a DRVOWA managed WhatsApp accountKey.
 * Rejects path traversal, absolute paths, slashes, and unsafe characters.
 * @param {unknown} value
 * @returns {{ ok: true, accountKey: string } | { ok: false, error: string }}
 */
function validateAccountKey(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: 'accountKey must be a string' };
  }
  const accountKey = value.trim();
  if (!accountKey) {
    return { ok: false, error: 'accountKey is required' };
  }
  if (accountKey.includes('..') || accountKey.includes('/') || accountKey.includes('\\')) {
    return { ok: false, error: 'accountKey contains unsafe path characters' };
  }
  if (accountKey.includes('\0')) {
    return { ok: false, error: 'accountKey contains unsafe characters' };
  }
  if (!ACCOUNT_KEY_RE.test(accountKey)) {
    return {
      ok: false,
      error: 'accountKey must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',
    };
  }
  return { ok: true, accountKey };
}

module.exports = {
  validateAccountKey,
  ACCOUNT_KEY_RE,
};
