'use strict';

const path = require('path');
const { createSendQueue } = require('../sendQueue');
const { validateAccountKey } = require('./accountKey');
const { createBaileysProvider } = require('./baileysProvider');
const { CONNECTION_STATES } = require('./connectionStates');
const {
  createManagedAccountRegistry,
  DESIRED_RUNNING,
  DESIRED_STOPPED,
} = require('./managedAccountRegistry');
const {
  isMultiAccountEnabled,
  getManagedAuthBaseDir,
  getSendQueueMax,
} = require('./s2sAuth');

/**
 * Multi-account WhatsApp runtime manager.
 * Legacy Cut Salon singleton remains separate and untouched.
 */
function createWhatsAppAccountManager({
  createProvider = createBaileysProvider,
  createQueue = createSendQueue,
  enabled = isMultiAccountEnabled,
  authBaseDir = getManagedAuthBaseDir(),
  sendQueueMax = getSendQueueMax(),
  registry = createManagedAccountRegistry(),
  logger = console,
} = {}) {
  /** @type {Map<string, { provider: any, queue: any }>} */
  const accounts = new Map();

  function assertEnabled() {
    if (!enabled()) {
      const err = new Error('DRVOWA multi-account runtime is disabled');
      err.code = 'MULTI_ACCOUNT_DISABLED';
      err.status = 503;
      throw err;
    }
  }

  function requireValidKey(accountKey) {
    const validated = validateAccountKey(accountKey);
    if (!validated.ok) {
      const err = new Error(validated.error);
      err.code = 'INVALID_ACCOUNT_KEY';
      err.status = 400;
      throw err;
    }
    return validated.accountKey;
  }

  function persistDesired(accountKey, desiredState) {
    try {
      registry.setDesiredState(accountKey, desiredState);
    } catch (err) {
      logger.error('[drvowa-registry] persist_failed', {
        accountKey,
        desiredState,
        code: err && err.code ? err.code : 'REGISTRY_WRITE_FAILED',
      });
    }
  }

  function markLoggedOutStopped(accountKey) {
    persistDesired(accountKey, DESIRED_STOPPED);
  }

  function getOrCreate(accountKey) {
    const key = requireValidKey(accountKey);
    let entry = accounts.get(key);
    if (entry) return entry;

    const provider = createProvider({
      accountKey: key,
      authBaseDir,
      logger,
      printQrToTerminal: false,
      onLoggedOut: () => {
        markLoggedOutStopped(key);
      },
    });
    const queue = createQueue({ concurrency: 1, maxQueued: sendQueueMax });
    entry = { provider, queue };
    accounts.set(key, entry);
    return entry;
  }

  async function start(accountKey) {
    assertEnabled();
    const key = requireValidKey(accountKey);
    persistDesired(key, DESIRED_RUNNING);

    const existing = accounts.get(key);
    if (existing) {
      const status = existing.provider.getStatus();
      if (status.state === CONNECTION_STATES.LOGGED_OUT) {
        markLoggedOutStopped(key);
        return status;
      }
      if (status.state === CONNECTION_STATES.READY || status.ready) {
        return status;
      }
      if (status.state !== CONNECTION_STATES.STOPPED
        && status.state !== CONNECTION_STATES.ERROR) {
        return status;
      }
      const started = await existing.provider.start();
      if (started.state === CONNECTION_STATES.LOGGED_OUT) {
        markLoggedOutStopped(key);
      }
      return started;
    }

    const entry = getOrCreate(key);
    const started = await entry.provider.start();
    if (started.state === CONNECTION_STATES.LOGGED_OUT) {
      markLoggedOutStopped(key);
    }
    return started;
  }

  async function stop(accountKey) {
    assertEnabled();
    const key = requireValidKey(accountKey);
    persistDesired(key, DESIRED_STOPPED);

    const entry = accounts.get(key);
    if (!entry) {
      return {
        accountKey: key,
        state: CONNECTION_STATES.STOPPED,
        ready: false,
        qrAvailable: false,
        lastConnectedAt: null,
        lastDisconnectAt: null,
        lastDisconnectCode: null,
        lastErrorCode: null,
        reconnectAttempts: 0,
      };
    }
    const status = await entry.provider.stop();
    accounts.delete(key);
    return status;
  }

  function status(accountKey) {
    assertEnabled();
    const key = requireValidKey(accountKey);
    const entry = accounts.get(key);
    if (!entry) {
      return {
        accountKey: key,
        state: CONNECTION_STATES.STOPPED,
        ready: false,
        qrAvailable: false,
        lastConnectedAt: null,
        lastDisconnectAt: null,
        lastDisconnectCode: null,
        lastErrorCode: null,
        reconnectAttempts: 0,
        authDir: path.join(authBaseDir, key),
      };
    }
    return entry.provider.getStatus();
  }

  function qr(accountKey) {
    assertEnabled();
    const key = requireValidKey(accountKey);
    const entry = accounts.get(key);
    if (!entry) {
      return { accountKey: key, qr: null, qrAvailable: false };
    }
    const value = entry.provider.getQr();
    return {
      accountKey: key,
      qr: value || null,
      qrAvailable: Boolean(value),
    };
  }

  async function send(accountKey, payload) {
    assertEnabled();
    const key = requireValidKey(accountKey);
    const entry = accounts.get(key);
    if (!entry) {
      return {
        success: false,
        status: 'failed',
        error: 'Account runtime is not started',
        code: 'NOT_STARTED',
        httpStatus: 409,
      };
    }

    const current = entry.provider.getStatus();
    if (current.state === CONNECTION_STATES.LOGGED_OUT) {
      markLoggedOutStopped(key);
      return {
        success: false,
        status: 'failed',
        error: 'Account is logged out',
        code: 'LOGGED_OUT',
        httpStatus: 409,
      };
    }
    if (current.state !== CONNECTION_STATES.READY) {
      return {
        success: false,
        status: 'failed',
        error: `Account is not READY (state=${current.state})`,
        code: 'NOT_READY',
        httpStatus: 409,
      };
    }

    const phone = payload && payload.phone;
    const message = payload && payload.message;
    const idempotencyKey = payload && payload.idempotencyKey;
    if (!phone || !message) {
      return {
        success: false,
        status: 'failed',
        error: 'phone and message are required',
        code: 'INVALID_PAYLOAD',
        httpStatus: 400,
      };
    }

    try {
      return await entry.queue.enqueue(() => entry.provider.send(phone, message, {
        idempotencyKey,
      }));
    } catch (err) {
      if (err && err.code === 'QUEUE_FULL') {
        return {
          success: false,
          status: 'failed',
          error: 'Send queue is full',
          code: 'QUEUE_FULL',
          httpStatus: 429,
        };
      }
      throw err;
    }
  }

  function listAccountKeys() {
    return [...accounts.keys()];
  }

  function getAuthDir(accountKey) {
    const key = requireValidKey(accountKey);
    return path.join(authBaseDir, key);
  }

  async function stopAll() {
    const keys = [...accounts.keys()];
    for (const key of keys) {
      // stopAll during shutdown should not flip desiredState to STOPPED
      const entry = accounts.get(key);
      if (!entry) continue;
      try {
        await entry.provider.stop();
      } catch (_) {
        // ignore
      }
      accounts.delete(key);
    }
  }

  return {
    start,
    stop,
    status,
    qr,
    send,
    listAccountKeys,
    getAuthDir,
    stopAll,
    registry,
    _accounts: accounts,
  };
}

module.exports = {
  createWhatsAppAccountManager,
  DESIRED_RUNNING,
  DESIRED_STOPPED,
};
