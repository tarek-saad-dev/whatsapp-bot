'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { CONNECTION_STATES } = require('../connectionStates');
const { createOutboundIdempotencyStore } = require('../outboundIdempotencyStore');
const { sendManagedWithIdempotency } = require('../managedOutboundSend');
const { createOutboundNumberSafety } = require('../outboundNumberSafety');
const { getManagedAuthBaseDirV7 } = require('../runtimeEngine');

const WORKER_ENTRY = path.resolve(
  __dirname,
  '../../../packages/baileys-v7-worker/src/worker.js',
);

/**
 * Exclusive authDir lock — one process owner per v7 auth directory.
 * Stale locks (dead pid) are reclaimed.
 */
function acquireAuthLock(authDir) {
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(authDir, '.owner.lock');

  function tryCreate() {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        return null;
      }
      throw err;
    }
    const payload = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    fs.writeFileSync(fd, payload, 'utf8');
    return {
      lockPath,
      release() {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      },
    };
  }

  let lock = tryCreate();
  if (lock) return lock;

  // Reclaim stale lock if owner pid is dead
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    const ownerPid = Number(parsed && parsed.pid);
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        // still alive
      } catch {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
        lock = tryCreate();
        if (lock) return lock;
      }
    }
  } catch {
    /* ignore */
  }

  const e = new Error('V7 authDir already has an active owner');
  e.code = 'AUTH_OWNERSHIP_CONFLICT';
  e.status = 409;
  throw e;
}

/**
 * CJS supervisor bridge: forks isolated ESM Baileys v7 worker per account.
 */
function createV7WorkerProvider({
  accountKey,
  authBaseDir = getManagedAuthBaseDirV7(),
  logger = console,
  onLoggedOut = null,
  workerEntry = WORKER_ENTRY,
  forkFn = fork,
} = {}) {
  const authDir = path.join(authBaseDir, accountKey);
  const idempotencyFile = path.join(authDir, 'outbound-idempotency.json');
  const idempotencyStore = createOutboundIdempotencyStore({ filePath: idempotencyFile });
  const numberSafety = createOutboundNumberSafety({ accountKey, logger });

  let child = null;
  let lock = null;
  let lastStatus = {
    accountKey,
    runtimeEngine: 'BAILEYS_V7',
    baileysVersion: '7.0.0-rc14',
    state: CONNECTION_STATES.STOPPED,
    ready: false,
    qrAvailable: false,
    lastConnectedAt: null,
    lastDisconnectAt: null,
    lastDisconnectCode: null,
    lastErrorCode: null,
    reconnectAttempts: 0,
    authDir,
    cryptoHealth: {
      plaintextInboundCount: 0,
      decryptFailureCount: 0,
      messageAbsentFromNodeCount: 0,
      lastPlaintextInboundAt: null,
      lastDecryptFailureAt: null,
      cryptoHealth: 'UNKNOWN',
    },
  };
  let lastQr = null;
  let requestSeq = 0;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  const pending = new Map();

  function nextRequestId() {
    requestSeq += 1;
    return requestSeq;
  }

  function sendIpc(message, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      if (!child || !child.connected) {
        reject(Object.assign(new Error('V7 worker not running'), { code: 'NOT_STARTED' }));
        return;
      }
      const requestId = nextRequestId();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Object.assign(new Error('V7 worker IPC timeout'), { code: 'IPC_TIMEOUT' }));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      child.send({ ...message, requestId });
    });
  }

  function handleChildMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'status' && msg.status) {
      lastStatus = { ...lastStatus, ...msg.status, authDir };
      if (lastStatus.state === CONNECTION_STATES.LOGGED_OUT && typeof onLoggedOut === 'function') {
        try {
          onLoggedOut();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (msg.type === 'reply') {
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.requestId);
      if (msg.ok === false) {
        entry.reject(Object.assign(new Error(msg.error || 'worker_error'), {
          code: msg.code || 'WORKER_ERROR',
        }));
        return;
      }
      entry.resolve(msg);
    }
  }

  function spawnWorker() {
    if (child) {
      throw Object.assign(new Error('V7 worker already running'), { code: 'ALREADY_STARTED' });
    }
    lock = acquireAuthLock(authDir);
    child = forkFn(workerEntry, [], {
      cwd: path.dirname(path.dirname(workerEntry)),
      env: {
        ...process.env,
        V7_ACCOUNT_KEY: accountKey,
        V7_AUTH_DIR: authDir,
        V7_S2S_ENABLED: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', handleChildMessage);
    child.stdout?.on('data', (buf) => {
      logger.info?.('[v7-worker-stdout]', String(buf).trim().slice(0, 300));
    });
    child.stderr?.on('data', (buf) => {
      logger.error?.('[v7-worker-stderr]', String(buf).trim().slice(0, 300));
    });
    child.on('exit', (code, signal) => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(Object.assign(new Error('V7 worker exited'), { code: 'WORKER_EXIT' }));
      }
      pending.clear();
      child = null;
      if (lock) {
        lock.release();
        lock = null;
      }
      if (lastStatus.state !== CONNECTION_STATES.LOGGED_OUT
        && lastStatus.state !== CONNECTION_STATES.STOPPED) {
        lastStatus = {
          ...lastStatus,
          state: CONNECTION_STATES.STOPPED,
          ready: false,
          lastErrorCode: signal || `EXIT_${code}`,
        };
      }
      logger.warn?.('[v7-worker] exited', { accountKey, code, signal });
    });
  }

  async function start() {
    if (child && child.connected) {
      const reply = await sendIpc({ type: 'getStatus' });
      lastStatus = { ...lastStatus, ...reply.status, authDir };
      return getStatus();
    }
    lastStatus = { ...lastStatus, state: CONNECTION_STATES.STARTING, ready: false };
    spawnWorker();
    // Wait briefly for first status
    await new Promise((r) => setTimeout(r, 500));
    try {
      const reply = await sendIpc({ type: 'getStatus' }, 20_000);
      lastStatus = { ...lastStatus, ...reply.status, authDir };
    } catch (err) {
      lastStatus = {
        ...lastStatus,
        state: CONNECTION_STATES.ERROR,
        lastErrorCode: err.code || 'START_FAILED',
      };
    }
    return getStatus();
  }

  async function stop() {
    if (!child) {
      lastStatus = {
        ...lastStatus,
        state: CONNECTION_STATES.STOPPED,
        ready: false,
        qrAvailable: false,
      };
      return getStatus();
    }
    try {
      await sendIpc({ type: 'stop' }, 10_000);
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    // Wait for exit
    await new Promise((resolve) => {
      if (!child) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    lastStatus = {
      ...lastStatus,
      state: CONNECTION_STATES.STOPPED,
      ready: false,
      qrAvailable: false,
    };
    return getStatus();
  }

  function getStatus() {
    return { ...lastStatus, authDir, runtimeEngine: 'BAILEYS_V7' };
  }

  function getQr() {
    return lastQr || lastStatus.qr || null;
  }

  async function refreshQr() {
    if (!child) return { accountKey, qr: null, qrAvailable: false };
    const reply = await sendIpc({ type: 'getQr' });
    lastQr = reply.qr?.qr || null;
    return reply.qr;
  }

  async function send(phone, message, { idempotencyKey } = {}) {
    const state = lastStatus.state;
    if (state === CONNECTION_STATES.LOGGED_OUT) {
      return {
        success: false,
        status: 'failed',
        error: 'Account is logged out',
        code: 'LOGGED_OUT',
        idempotencyKey: idempotencyKey || undefined,
      };
    }
    if (state !== CONNECTION_STATES.READY) {
      return {
        success: false,
        status: 'failed',
        error: `Account is not READY (state=${state})`,
        code: 'NOT_READY',
        idempotencyKey: idempotencyKey || undefined,
      };
    }
    return sendManagedWithIdempotency({
      accountKey,
      phone,
      message,
      idempotencyKey,
      store: idempotencyStore,
      numberSafety,
      logger,
      sendFn: async (p, m) => {
        const reply = await sendIpc({
          type: 'send',
          phone: p,
          message: m,
          idempotencyKey,
        }, 60_000);
        return reply.result;
      },
    });
  }

  return {
    accountKey,
    authDir,
    runtimeEngine: 'BAILEYS_V7',
    start,
    stop,
    getStatus,
    getQr,
    refreshQr,
    send,
  };
}

module.exports = {
  createV7WorkerProvider,
  acquireAuthLock,
  WORKER_ENTRY,
};
