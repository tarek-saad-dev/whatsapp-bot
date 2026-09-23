'use strict';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createUnresolvedLidPendingBuffer } = require(
  '../../services/transport/baileys/unresolvedLidPending',
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
    const buf = createUnresolvedLidPendingBuffer({ timeoutMs: 1000 });
    const msg = { key: { id: 'M1', remoteJid: '1@lid' } };
    expect(buf.enqueue('M1', { msg, upsertType: 'notify' }, onTimeout).ok).toBe(true);
    expect(buf.size()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(buf.size()).toBe(0);
  });

  it('take cancels timeout', () => {
    const onTimeout = vi.fn();
    const buf = createUnresolvedLidPendingBuffer({ timeoutMs: 1000 });
    buf.enqueue('M2', { msg: { key: { id: 'M2' } } }, onTimeout);
    expect(buf.take('M2')).toBeTruthy();
    vi.advanceTimersByTime(2000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rejects when buffer full', () => {
    const buf = createUnresolvedLidPendingBuffer({ timeoutMs: 5000, maxEntries: 1 });
    expect(buf.enqueue('A', { msg: {} }, () => {}).ok).toBe(true);
    expect(buf.enqueue('B', { msg: {} }, () => {}).ok).toBe(false);
    buf.clear();
  });
});
