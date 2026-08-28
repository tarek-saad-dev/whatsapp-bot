import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
const { createInboxListener } = require('../../services/inbox/inboxListener');
const { createInboxSpool } = require('../../services/inbox/inboxSpool');

describe('inboxListener (phase1)', () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-listener-'));
  });

  function makeSpool() {
    return createInboxSpool({ spoolFile: path.join(tempDir, 'spool.json') });
  }

  function makeWorker() {
    return { start: vi.fn(), stop: vi.fn(), tick: vi.fn(), getStatus: () => ({ running: false }) };
  }

  it('starts without blocking on driver init', () => {
    const listener = createInboxListener({
      getDriver: () => null,
      getOrCreateDriver: vi.fn(() => new Promise(() => {})),
      spool: makeSpool(),
      deliveryWorker: makeWorker(),
    });

    const status = listener.start({ initDriver: true });
    expect(status.listening).toBe(true);
    expect(status.mode).toBe('phase1.1');
    listener.stop();
  });

  it('does not poll while outbound send queue is active', async () => {
    const driver = { executeScript: vi.fn() };
    const listener = createInboxListener({
      getDriver: () => driver,
      isReady: async () => true,
      sendQueue: { getStats: () => ({ active: 1, queued: 0 }), enqueue: vi.fn() },
      spool: makeSpool(),
      deliveryWorker: makeWorker(),
    });

    listener.start();
    await listener.tick();
    expect(driver.executeScript).not.toHaveBeenCalled();
    listener.stop();
  });
});
