'use strict';

const crypto = require('crypto');

function isMultiAccountEnabled() {
  return String(process.env.DRVOWA_MULTI_ACCOUNT_ENABLED || 'false').toLowerCase() === 'true';
}

function getRuntimeToken() {
  const token = process.env.DRVOWA_RUNTIME_TOKEN;
  if (typeof token !== 'string' || token.trim().length === 0) {
    return null;
  }
  return token.trim();
}

/**
 * Constant-time Bearer token check. Never logs the token.
 * @param {string|undefined|null} authorizationHeader
 */
function verifyRuntimeBearer(authorizationHeader) {
  const expected = getRuntimeToken();
  if (!expected) {
    return { ok: false, status: 503, error: 'DRVOWA runtime token is not configured' };
  }
  if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing or invalid Authorization bearer token' };
  }
  const provided = authorizationHeader.slice('Bearer '.length).trim();
  if (!provided) {
    return { ok: false, status: 401, error: 'Missing or invalid Authorization bearer token' };
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'Invalid Authorization bearer token' };
  }
  return { ok: true };
}

function getManagedAuthBaseDir() {
  return process.env.DRVOWA_BAILEYS_AUTH_ACCOUNTS_DIR
    || require('path').join(process.cwd(), 'data', 'baileys-auth-accounts');
}

function getSendQueueMax() {
  const raw = Number(process.env.DRVOWA_SEND_QUEUE_MAX || 50);
  if (!Number.isInteger(raw) || raw < 1) return 50;
  return raw;
}

module.exports = {
  isMultiAccountEnabled,
  getRuntimeToken,
  verifyRuntimeBearer,
  getManagedAuthBaseDir,
  getSendQueueMax,
};
