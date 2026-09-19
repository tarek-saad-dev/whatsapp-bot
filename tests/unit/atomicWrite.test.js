'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { writeAtomicFile } = require('../../services/drvowa/atomicWrite');
const {
  createOutboundIdempotencyStore,
} = require('../../services/drvowa/outboundIdempotencyStore');

describe('atomicWrite last-known-good durability (M2)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function wrapFs(overrides = {}) {
    return {
      mkdirSync: (...a) => fs.mkdirSync(...a),
      openSync: (...a) => fs.openSync(...a),
      writeSync: (...a) => fs.writeSync(...a),
      fsyncSync: (...a) => fs.fsyncSync(...a),
      closeSync: (...a) => fs.closeSync(...a),
      renameSync: (...a) => fs.renameSync(...a),
      unlinkSync: (...a) => fs.unlinkSync(...a),
      ...overrides,
    };
  }

  it('repeated writes leave valid JSON', () => {
    const filePath = path.join(tmpDir, 'state.json');
    writeAtomicFile(filePath, JSON.stringify({ n: 1 }));
    writeAtomicFile(filePath, JSON.stringify({ n: 2 }));
    writeAtomicFile(filePath, JSON.stringify({ n: 3 }));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ n: 3 });
  });

  it('write failure preserves previous committed file', () => {
    const filePath = path.join(tmpDir, 'state.json');
    writeAtomicFile(filePath, JSON.stringify({ good: true }));
    const failing = wrapFs({
      writeSync() {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    });
    expect(() => writeAtomicFile(filePath, JSON.stringify({ bad: true }), { fsImpl: failing }))
      .toThrow(/disk full/);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ good: true });
  });

  it('fsync failure preserves previous committed file', () => {
    const filePath = path.join(tmpDir, 'state.json');
    writeAtomicFile(filePath, JSON.stringify({ good: true }));
    let fsynced = false;
    const failing = wrapFs({
      fsyncSync(fd) {
        if (!fsynced) {
          fsynced = true;
          throw Object.assign(new Error('fsync failed'), { code: 'EIO' });
        }
        return fs.fsyncSync(fd);
      },
    });
    expect(() => writeAtomicFile(filePath, JSON.stringify({ bad: true }), { fsImpl: failing }))
      .toThrow(/fsync failed/);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ good: true });
  });

  it('rename failure preserves previous committed file', () => {
    const filePath = path.join(tmpDir, 'state.json');
    writeAtomicFile(filePath, JSON.stringify({ good: true }));
    const failing = wrapFs({
      renameSync() {
        throw Object.assign(new Error('rename blocked'), { code: 'EBUSY' });
      },
    });
    expect(() => writeAtomicFile(filePath, JSON.stringify({ bad: true }), { fsImpl: failing }))
      .toThrow(/rename blocked/);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ good: true });
  });

  it('idempotency store reloads last good committed state after failed persist attempt', () => {
    const filePath = path.join(tmpDir, 'outbound-idempotency.json');
    const store = createOutboundIdempotencyStore({ filePath });
    store.reserveSending({ idempotencyKey: 'k1', phone: '201555111111', payloadHash: 'h' });
    expect(store.get('k1')).not.toBeNull();

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(raw.entries).toHaveLength(1);

    // Simulate a crash mid-write: leave a stale .tmp and keep destination intact.
    fs.writeFileSync(`${filePath}.999.tmp`, '{broken', 'utf8');
    const store2 = createOutboundIdempotencyStore({ filePath });
    expect(store2.get('k1')).not.toBeNull();
    expect(store2.get('k1').state).toBe('SENDING');
  });
});
