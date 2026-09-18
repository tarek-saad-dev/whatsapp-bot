'use strict';

const { isMultiAccountEnabled } = require('./s2sAuth');
const { CONNECTION_STATES } = require('./connectionStates');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRestoreConcurrency() {
  const raw = Number(process.env.DRVOWA_RESTORE_CONCURRENCY || 2);
  if (!Number.isInteger(raw) || raw < 1) return 2;
  return Math.min(raw, 10);
}

function getRestoreStaggerMs() {
  const raw = Number(process.env.DRVOWA_RESTORE_STAGGER_MS || 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(raw, 5_000);
}

/**
 * Bounded recovery of managed accounts marked RUNNING in the registry.
 */
async function recoverManagedAccounts({
  manager,
  registry,
  enabled = isMultiAccountEnabled,
  concurrency = getRestoreConcurrency(),
  staggerMs = getRestoreStaggerMs(),
  logger = console,
} = {}) {
  if (!enabled()) {
    return {
      attempted: 0,
      ready: 0,
      failed: 0,
      loggedOut: 0,
      skipped: true,
    };
  }

  logger.info('[drvowa-recovery] started');

  let runningKeys = [];
  try {
    registry.load();
    runningKeys = registry.listRunningAccountKeys();
  } catch (err) {
    logger.error('[drvowa-recovery] registry_load_failed', {
      code: err && err.code ? err.code : 'REGISTRY_LOAD_FAILED',
    });
    return {
      attempted: 0,
      ready: 0,
      failed: 1,
      loggedOut: 0,
      skipped: false,
    };
  }

  const summary = {
    attempted: runningKeys.length,
    ready: 0,
    failed: 0,
    loggedOut: 0,
    skipped: false,
  };

  let index = 0;

  async function worker() {
    while (index < runningKeys.length) {
      const current = index;
      index += 1;
      const accountKey = runningKeys[current];
      if (staggerMs > 0 && current > 0) {
        await sleep(staggerMs);
      }
      try {
        const status = await manager.start(accountKey);
        if (status.state === CONNECTION_STATES.LOGGED_OUT) {
          summary.loggedOut += 1;
          try {
            registry.setDesiredState(accountKey, registry.DESIRED_STOPPED);
          } catch (_) {
            // ignore registry write failure for logged-out mark
          }
          logger.warn('[drvowa-recovery] account_logged_out', { accountKey });
          continue;
        }
        if (status.state === CONNECTION_STATES.READY || status.ready) {
          summary.ready += 1;
          logger.info('[drvowa-recovery] account_ready', { accountKey });
          continue;
        }
        // QR_REQUIRED / CONNECTING / etc. — still recovered into manager
        if (status.state === CONNECTION_STATES.ERROR) {
          summary.failed += 1;
          logger.error('[drvowa-recovery] account_failed', {
            accountKey,
            code: status.lastErrorCode || 'ERROR',
          });
        } else {
          summary.ready += 1;
          logger.info('[drvowa-recovery] account_ready', {
            accountKey,
            state: status.state,
          });
        }
      } catch (err) {
        summary.failed += 1;
        logger.error('[drvowa-recovery] account_failed', {
          accountKey,
          code: err && err.code ? err.code : 'START_FAILED',
        });
      }
    }
  }

  const workers = [];
  const n = Math.min(concurrency, Math.max(runningKeys.length, 1));
  for (let i = 0; i < n && runningKeys.length > 0; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  logger.info('[drvowa-recovery] complete', {
    attempted: summary.attempted,
    ready: summary.ready,
    failed: summary.failed,
    loggedOut: summary.loggedOut,
  });

  return summary;
}

module.exports = {
  recoverManagedAccounts,
  getRestoreConcurrency,
  getRestoreStaggerMs,
};
