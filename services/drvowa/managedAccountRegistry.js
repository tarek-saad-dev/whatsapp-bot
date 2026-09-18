'use strict';

const fs = require('fs');
const path = require('path');
const { getManagedAuthBaseDir } = require('./s2sAuth');
const { validateAccountKey } = require('./accountKey');

const DESIRED_RUNNING = 'RUNNING';
const DESIRED_STOPPED = 'STOPPED';

function defaultRegistryPath() {
  if (process.env.DRVOWA_MANAGED_REGISTRY_FILE
    && String(process.env.DRVOWA_MANAGED_REGISTRY_FILE).trim()) {
    return path.resolve(String(process.env.DRVOWA_MANAGED_REGISTRY_FILE).trim());
  }
  return path.join(getManagedAuthBaseDir(), 'runtime-registry.json');
}

function emptyDoc() {
  return { version: 1, accounts: {} };
}

function normalizeDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyDoc();
  }
  const accounts = raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)
    ? raw.accounts
    : {};
  return {
    version: 1,
    accounts: { ...accounts },
  };
}

/**
 * Persistent desired-state registry for managed WhatsApp accounts.
 * Stores only RUNNING/STOPPED intent — never credentials, QR, or BusinessID.
 */
function createManagedAccountRegistry({
  filePath = defaultRegistryPath(),
  now = () => new Date().toISOString(),
} = {}) {
  let cache = null;

  function ensureDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function readSync() {
    try {
      if (!fs.existsSync(filePath)) {
        cache = emptyDoc();
        return cache;
      }
      const text = fs.readFileSync(filePath, 'utf8');
      if (!text.trim()) {
        cache = emptyDoc();
        return cache;
      }
      cache = normalizeDoc(JSON.parse(text));
      return cache;
    } catch (_) {
      // Corrupt/missing registry must fail safely — start empty, do not crash.
      cache = emptyDoc();
      return cache;
    }
  }

  function writeAtomic(doc) {
    ensureDir();
    const payload = `${JSON.stringify(doc, null, 2)}\n`;
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, payload, 0, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, filePath);
    } catch (err) {
      // Windows cannot always rename over an existing destination.
      if (err && (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES')) {
        try {
          fs.unlinkSync(filePath);
        } catch (_) {
          // ignore
        }
        fs.renameSync(tmp, filePath);
      } else {
        try {
          fs.unlinkSync(tmp);
        } catch (_) {
          // ignore
        }
        throw err;
      }
    }
    cache = doc;
  }

  function load() {
    return readSync();
  }

  function getDesiredState(accountKey) {
    const validated = validateAccountKey(accountKey);
    if (!validated.ok) return null;
    const doc = cache || readSync();
    const entry = doc.accounts[validated.accountKey];
    if (!entry || typeof entry !== 'object') return null;
    if (entry.desiredState === DESIRED_RUNNING || entry.desiredState === DESIRED_STOPPED) {
      return entry.desiredState;
    }
    return null;
  }

  function setDesiredState(accountKey, desiredState) {
    const validated = validateAccountKey(accountKey);
    if (!validated.ok) {
      const err = new Error(validated.error);
      err.code = 'INVALID_ACCOUNT_KEY';
      throw err;
    }
    if (desiredState !== DESIRED_RUNNING && desiredState !== DESIRED_STOPPED) {
      throw new Error('desiredState must be RUNNING or STOPPED');
    }
    const doc = normalizeDoc(cache || readSync());
    doc.accounts[validated.accountKey] = {
      desiredState,
      updatedAt: now(),
    };
    writeAtomic(doc);
    return doc.accounts[validated.accountKey];
  }

  function listRunningAccountKeys() {
    const doc = cache || readSync();
    const keys = [];
    for (const [key, entry] of Object.entries(doc.accounts || {})) {
      const validated = validateAccountKey(key);
      if (!validated.ok) continue;
      if (entry && entry.desiredState === DESIRED_RUNNING) {
        keys.push(validated.accountKey);
      }
    }
    return keys;
  }

  function getFilePath() {
    return filePath;
  }

  return {
    load,
    getDesiredState,
    setDesiredState,
    listRunningAccountKeys,
    getFilePath,
    DESIRED_RUNNING,
    DESIRED_STOPPED,
  };
}

module.exports = {
  createManagedAccountRegistry,
  DESIRED_RUNNING,
  DESIRED_STOPPED,
  defaultRegistryPath,
};
