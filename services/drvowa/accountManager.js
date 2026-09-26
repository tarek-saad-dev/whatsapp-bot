'use strict';

const path = require('path');
const { createSendQueue } = require('../sendQueue');
const { validateAccountKey } = require('./accountKey');
const { createBaileysProvider } = require('./baileysProvider');
const { createV7WorkerProvider } = require('./v7/v7WorkerProvider');
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
const {
  RUNTIME_ENGINE_V6,
  RUNTIME_ENGINE_V7,
  normalizeRuntimeEngine,
  getManagedAuthBaseDirV7,
} = require('./runtimeEngine');
const {
  attachCompatibilityDiagnostics,
} = require('./compatibilityClassifier');

/**
 * Multi-account WhatsApp runtime manager with selective engine dispatch.
 * BAILEYS_V6 → in-process provider; BAILEYS_V7 → isolated worker process.
 * Invariant: one accountKey → one engine owner (never v6+v7 simultaneously).
 */
function createWhatsAppAccountManager({
  createProvider = createBaileysProvider,
  createV7Provider = createV7WorkerProvider,
  createQueue = createSendQueue,
  enabled = isMultiAccountEnabled,
  authBaseDir = getManagedAuthBaseDir(),
  authBaseDirV7 = getManagedAuthBaseDirV7(),
  sendQueueMax = getSendQueueMax(),
  registry = createManagedAccountRegistry(),
  logger = console,
} = {}) {
  /** @type {Map<string, { provider: any, queue: any, runtimeEngine: string }>} */
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

  function persistDesired(accountKey, desiredState, runtimeEngine) {
    try {
      registry.setDesiredState(accountKey, desiredState, { runtimeEngine });
    } catch (err) {
      logger.error('[drvowa-registry] persist_failed', {
        accountKey,
        desiredState,
        code: err && err.code ? err.code : 'REGISTRY_WRITE_FAILED',
      });
    }
  }

  function markLoggedOutStopped(accountKey) {
    const engine = accounts.get(accountKey)?.runtimeEngine
      || registry.getRuntimeEngine?.(accountKey)
      || RUNTIME_ENGINE_V6;
    persistDesired(accountKey, DESIRED_STOPPED, engine);
  }

  function resolveEngine(accountKey, requested) {
    const fromRequest = requested ? normalizeRuntimeEngine(requested) : null;
    const fromRegistry = registry.getRuntimeEngine
      ? registry.getRuntimeEngine(accountKey)
      : RUNTIME_ENGINE_V6;
    return fromRequest || fromRegistry || RUNTIME_ENGINE_V6;
  }

  function getOrCreate(accountKey, runtimeEngine) {
    const key = requireValidKey(accountKey);
    const engine = normalizeRuntimeEngine(runtimeEngine);
    let entry = accounts.get(key);
    if (entry) {
      if (entry.runtimeEngine !== engine) {
        const err = new Error(
          `Account already owned by ${entry.runtimeEngine}; stop before switching to ${engine}`,
        );
        err.code = 'ENGINE_OWNERSHIP_CONFLICT';
        err.status = 409;
        throw err;
      }
      return entry;
    }

    const onLoggedOut = () => {
      markLoggedOutStopped(key);
    };

    const provider = engine === RUNTIME_ENGINE_V7
      ? createV7Provider({
        accountKey: key,
        authBaseDir: authBaseDirV7,
        logger,
        onLoggedOut,
      })
      : createProvider({
        accountKey: key,
        authBaseDir,
        logger,
        printQrToTerminal: false,
        onLoggedOut,
      });

    const queue = createQueue({ concurrency: 1, maxQueued: sendQueueMax });
    entry = { provider, queue, runtimeEngine: engine };
    accounts.set(key, entry);
    return entry;
  }

  async function start(accountKey, options = {}) {
    assertEnabled();
    const key = requireValidKey(accountKey);
    const engine = resolveEngine(key, options.runtimeEngine);
    persistDesired(key, DESIRED_RUNNING, engine);

    const existing = accounts.get(key);
    if (existing) {
      if (existing.runtimeEngine !== engine) {
        const err = new Error(
          `Account already owned by ${existing.runtimeEngine}; stop before switching to ${engine}`,
        );
        err.code = 'ENGINE_OWNERSHIP_CONFLICT';
        err.status = 409;
        throw err;
      }
      const status = existing.provider.getStatus();
      if (status.state === CONNECTION_STATES.LOGGED_OUT) {
        markLoggedOutStopped(key);
        return { ...status, runtimeEngine: engine };
      }
      if (status.state === CONNECTION_STATES.READY || status.ready) {
        return { ...status, runtimeEngine: engine };
      }
      if (status.state !== CONNECTION_STATES.STOPPED
        && status.state !== CONNECTION_STATES.ERROR) {
        return { ...status, runtimeEngine: engine };
      }
      const started = await existing.provider.start();
      if (started.state === CONNECTION_STATES.LOGGED_OUT) {
        markLoggedOutStopped(key);
      }
      return { ...started, runtimeEngine: engine };
    }

    const entry = getOrCreate(key, engine);
    const started = await entry.provider.start();
    if (started.state === CONNECTION_STATES.LOGGED_OUT) {
      markLoggedOutStopped(key);
    }
    return { ...started, runtimeEngine: engine };
  }

  async function stop(accountKey) {
    assertEnabled();
    const key = requireValidKey(accountKey);
    const engine = accounts.get(key)?.runtimeEngine
      || (registry.getRuntimeEngine ? registry.getRuntimeEngine(key) : RUNTIME_ENGINE_V6);
    persistDesired(key, DESIRED_STOPPED, engine);

    const entry = accounts.get(key);
    if (!entry) {
      return {
        accountKey: key,
        runtimeEngine: engine,
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
    return { ...status, runtimeEngine: entry.runtimeEngine };
  }

  function status(accountKey) {
    assertEnabled();
    const key = requireValidKey(accountKey);
    const entry = accounts.get(key);
    const engine = entry?.runtimeEngine
      || (registry.getRuntimeEngine ? registry.getRuntimeEngine(key) : RUNTIME_ENGINE_V6);
    if (!entry) {
      const base = engine === RUNTIME_ENGINE_V7 ? authBaseDirV7 : authBaseDir;
      return attachCompatibilityDiagnostics({
        accountKey: key,
        runtimeEngine: engine,
        state: CONNECTION_STATES.STOPPED,
        ready: false,
        qrAvailable: false,
        lastConnectedAt: null,
        lastDisconnectAt: null,
        lastDisconnectCode: null,
        lastErrorCode: null,
        reconnectAttempts: 0,
        authDir: path.join(base, key),
      });
    }
    return attachCompatibilityDiagnostics({
      ...entry.provider.getStatus(),
      runtimeEngine: entry.runtimeEngine,
    });
  }

  function qr(accountKey) {
    assertEnabled();
    const key = requireValidKey(accountKey);
    const entry = accounts.get(key);
    if (!entry) {
      return { accountKey: key, qr: null, qrAvailable: false };
    }
    if (typeof entry.provider.refreshQr === 'function') {
      // sync path for API — use cached getQr; async refresh is best-effort
      entry.provider.refreshQr().catch(() => {});
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
    const entry = accounts.get(key);
    const engine = entry?.runtimeEngine
      || (registry.getRuntimeEngine ? registry.getRuntimeEngine(key) : RUNTIME_ENGINE_V6);
    const base = engine === RUNTIME_ENGINE_V7 ? authBaseDirV7 : authBaseDir;
    return path.join(base, key);
  }

  async function stopAll() {
    const keys = [...accounts.keys()];
    for (const key of keys) {
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
  RUNTIME_ENGINE_V6,
  RUNTIME_ENGINE_V7,
};
