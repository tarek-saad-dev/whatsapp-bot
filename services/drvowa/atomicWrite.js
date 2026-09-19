'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Last-known-good atomic JSON/text write:
 * write temp → fsync → close → rename → best-effort dir fsync.
 * Never truncates the destination before a successful replacement.
 */
function writeAtomicFile(filePath, contents, {
  encoding = 'utf8',
  fsImpl = fs,
  fsync = true,
} = {}) {
  const dir = path.dirname(filePath);
  fsImpl.mkdirSync(dir, { recursive: true });
  const payload = typeof contents === 'string' ? contents : String(contents);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let fd = null;
  try {
    fd = fsImpl.openSync(tmp, 'w');
    fsImpl.writeSync(fd, payload, 0, encoding);
    if (fsync && typeof fsImpl.fsyncSync === 'function') {
      fsImpl.fsyncSync(fd);
    }
  } catch (err) {
    if (fd != null) {
      try { fsImpl.closeSync(fd); } catch (_) { /* ignore */ }
      fd = null;
    }
    try { fsImpl.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
  try {
    fsImpl.closeSync(fd);
    fd = null;
  } catch (err) {
    try { fsImpl.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }

  try {
    fsImpl.renameSync(tmp, filePath);
  } catch (err) {
    if (err && (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES')) {
      try {
        fsImpl.unlinkSync(filePath);
      } catch (_) {
        // ignore — may still allow rename
      }
      try {
        fsImpl.renameSync(tmp, filePath);
      } catch (err2) {
        try { fsImpl.unlinkSync(tmp); } catch (_) { /* ignore */ }
        throw err2;
      }
    } else {
      try { fsImpl.unlinkSync(tmp); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  // Best-effort parent directory fsync (not available on all platforms).
  if (fsync && typeof fsImpl.openSync === 'function' && typeof fsImpl.fsyncSync === 'function') {
    try {
      const dirFd = fsImpl.openSync(dir, 'r');
      try {
        fsImpl.fsyncSync(dirFd);
      } finally {
        fsImpl.closeSync(dirFd);
      }
    } catch (_) {
      // Windows / some FS may not support directory fsync — ignore.
    }
  }

  return filePath;
}

module.exports = {
  writeAtomicFile,
};
