'use strict';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { createUnresolvedLidPendingBuffer } = require(
  '../../services/transport/baileys/unresolvedLidPending',
);
const { createInboundQuarantineStore } = require(
  '../../services/transport/baileys/inboundQuarantineStore',
);

describe('unresolvedLidPending buffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues and fires timeout quarantine callback', () => {
    const onTimeout = vi.fn();
    const buf = createUnresolvedLidPendingBuffer({ timeoutMs: 1000, retryOffsetsMs: [] });
    const msg = { key: { id: 'M1', remoteJid: '1@lid' } };
    expect(buf.enqueue('M1', { msg, upsertType: 'notify' }, { onTimeout }).ok).toBe(true);
    expect(buf.size()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(buf.size()).toBe(0);
  });

  it('fires bounded resolve retries before timeout', () => {
    const onTimeout = vi.fn();
    const onRetry = vi.fn();
    const buf = createUnresolvedLidPendingBuffer({
      timeoutMs: 8000,
      retryOffsetsMs: [0, 1000, 3000],
    });
    buf.enqueue('M3', { msg: { key: { id: 'M3' } } }, { onTimeout, onRetry });
    vi.advanceTimersByTime(0);
    expect(onRetry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onRetry).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('take cancels timeout', () => {
    const onTimeout = vi.fn();
    const buf = createUnresolvedLidPendingBuffer({ timeoutMs: 1000, retryOffsetsMs: [] });
    buf.enqueue('M2', { msg: { key: { id: 'M2' } } }, { onTimeout });
    expect(buf.take('M2')).toBeTruthy();
    vi.advanceTimersByTime(2000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rejects when buffer full', () => {
    const buf = createUnresolvedLidPendingBuffer({ timeoutMs: 5000, maxEntries: 1, retryOffsetsMs: [] });
    expect(buf.enqueue('A', { msg: {} }, { onTimeout: () => {} }).ok).toBe(true);
    expect(buf.enqueue('B', { msg: {} }, { onTimeout: () => {} }).ok).toBe(false);
    buf.clear();
  });
});

describe('inboundQuarantineStore durable', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inq-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists and reloads entries', () => {
    const filePath = path.join(dir, 'inbound-quarantine.json');
    const store = createInboundQuarantineStore({ filePath });
    const put = store.put({
      messageId: 'Q1',
      remoteLid: '99@lid',
      reason: 'unresolved_lid_timeout',
      msg: { key: { id: 'Q1', remoteJid: '99@lid' }, message: { conversation: 'x' } },
    });
    expect(put.ok).toBe(true);
    expect(store.size()).toBe(1);

    const reloaded = createInboundQuarantineStore({ filePath });
    expect(reloaded.size()).toBe(1);
    expect(reloaded.get('Q1')?.reason).toBe('unresolved_lid_timeout');
    expect(reloaded.get('Q1')?.msg?.message?.conversation).toBe('x');
  });

  it('duplicate put is idempotent', () => {
    const filePath = path.join(dir, 'inbound-quarantine.json');
    const store = createInboundQuarantineStore({ filePath });
    expect(store.put({ messageId: 'Q2', msg: {} }).duplicate).toBe(false);
    expect(store.put({ messageId: 'Q2', msg: {} }).duplicate).toBe(true);
    expect(store.size()).toBe(1);
  });
});
