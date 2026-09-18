'use strict';

const { createWhatsAppAccountManager } = require('./accountManager');
const { createManagedAccountRegistry } = require('./managedAccountRegistry');
const { recoverManagedAccounts } = require('./managedAccountRecovery');
const { isMultiAccountEnabled } = require('./s2sAuth');

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

/**
 * Boot recovery for managed accounts with desiredState=RUNNING.
 * Safe no-op when multi-account is disabled. Never throws to caller.
 */
async function startManagedAccountRecovery(options = {}) {
  try {
    if (!isMultiAccountEnabled()) {
      return { attempted: 0, ready: 0, failed: 0, loggedOut: 0, skipped: true };
    }
    const manager = options.manager || getWhatsAppAccountManager();
    const registry = options.registry || manager.registry || createManagedAccountRegistry();
    return await recoverManagedAccounts({
      manager,
      registry,
      logger: options.logger || console,
      concurrency: options.concurrency,
      staggerMs: options.staggerMs,
      enabled: options.enabled || isMultiAccountEnabled,
    });
  } catch (err) {
    console.error('[drvowa-recovery] failed', {
      code: err && err.code ? err.code : 'RECOVERY_FAILED',
    });
    return { attempted: 0, ready: 0, failed: 1, loggedOut: 0, skipped: false };
  }
}

module.exports = {
  getWhatsAppAccountManager,
  _resetWhatsAppAccountManagerForTests,
  startManagedAccountRecovery,
  createManagedAccountRegistry,
  recoverManagedAccounts,
};
