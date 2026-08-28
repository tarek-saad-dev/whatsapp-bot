import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createInboxListener } = require('../../services/inbox/inboxListener');

function mockExecuteScript() {
  return vi.fn(async (fn) => {
    const src = typeof fn === 'function' ? fn.toString() : '';
    if (src.includes('installInboxTrigger')) {
      return { installed: true, trackedChats: 1 };
    }
    if (src.includes('installOpenChatMessageObserver')) {
      return { installed: true, attached: false, queued: 0 };
    }
    if (src.includes('getOpenChatObserverStatus')) {
      return { installed: true, attached: false, queued: 0 };
    }
    if (src.includes('drainOpenChatEvents')) {
      return { events: [], status: { installed: true, queued: 0 } };
    }
    if (src.includes('drainInboxEvents')) {
      return { events: [], status: { installed: true, queued: 0 } };
    }
    if (src.includes('scrapeChatRows')) {
      return [];
    }
    return null;
  });
}

describe('inbox listener lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries driver init during poll when driver was initially missing', async () => {
    let driver = null;
    const getOrCreateDriver = vi.fn(async () => {
      driver = { executeScript: mockExecuteScript() };
      return driver;
    });

    const listener = createInboxListener({
      getDriver: () => driver,
      getOrCreateDriver,
      isReady: async () => Boolean(driver),
      switchToWhatsAppTab: async () => true,
      sendQueue: {
        enqueue: (task) => task(),
        getStats: () => ({ active: 0, queued: 0 }),
        getTimingStats: () => ({ browserQueueWaitMs: 0, browserOperationMs: 0 }),
      },
      spool: {
        hasProviderMessageId: () => false,
        capture: vi.fn(),
        getStats: () => ({ pending: 0, delivered: 0, failedOrRetrying: 0 }),
      },
      deliveryWorker: {
        start: vi.fn(),
        stop: vi.fn(),
        tick: vi.fn(),
        getStatus: () => ({ running: true, webhookConfigured: false }),
      },
    });

    listener.start({ initDriver: false });
    await listener.pollOnce();

    expect(getOrCreateDriver).toHaveBeenCalledTimes(1);
    expect(listener.getStatus().lastPollAt).not.toBeNull();
    expect(listener.getStatus().triggerInstalled).toBe(true);
  });

  it('continues listening without webhook configured', async () => {
    const listener = createInboxListener({
      getDriver: () => null,
      getOrCreateDriver: vi.fn().mockRejectedValue(new Error('no chrome')),
      isReady: async () => false,
      sendQueue: { getStats: () => ({ active: 0, queued: 0 }) },
      deliveryWorker: {
        start: vi.fn(),
        stop: vi.fn(),
        tick: vi.fn(),
        getStatus: () => ({ running: true, webhookConfigured: false }),
      },
    });

    listener.start({ initDriver: true });
    await listener.tick();
    expect(listener.getStatus().listening).toBe(true);
    expect(listener.getStatus().deliveryWorker.webhookConfigured).toBe(false);
  });
});
