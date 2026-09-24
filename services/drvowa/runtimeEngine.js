'use strict';

const RUNTIME_ENGINE_V6 = 'BAILEYS_V6';
const RUNTIME_ENGINE_V7 = 'BAILEYS_V7';

function normalizeRuntimeEngine(value) {
  return value === RUNTIME_ENGINE_V7 ? RUNTIME_ENGINE_V7 : RUNTIME_ENGINE_V6;
}

function getManagedAuthBaseDirV7() {
  if (process.env.DRVOWA_BAILEYS_AUTH_ACCOUNTS_V7_DIR
    && String(process.env.DRVOWA_BAILEYS_AUTH_ACCOUNTS_V7_DIR).trim()) {
    return require('path').resolve(String(process.env.DRVOWA_BAILEYS_AUTH_ACCOUNTS_V7_DIR).trim());
  }
  const v6 = require('./s2sAuth').getManagedAuthBaseDir();
  return require('path').join(require('path').dirname(v6), 'baileys-auth-accounts-v7');
}

module.exports = {
  RUNTIME_ENGINE_V6,
  RUNTIME_ENGINE_V7,
  normalizeRuntimeEngine,
  getManagedAuthBaseDirV7,
};
