'use strict';

const { createWhatsAppAccountManager } = require('./accountManager');

/** Process-wide manager for DRVOWA multi-account runtimes (lazy). */
let singleton = null;

function getWhatsAppAccountManager() {
  if (!singleton) {
    singleton = createWhatsAppAccountManager();
  }
  return singleton;
}

/** Test helper */
function _resetWhatsAppAccountManagerForTests(instance = null) {
  singleton = instance;
}

module.exports = {
  getWhatsAppAccountManager,
  _resetWhatsAppAccountManagerForTests,
};
