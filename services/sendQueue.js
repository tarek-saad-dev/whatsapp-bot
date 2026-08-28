'use strict';

const { performance } = require('perf_hooks');

/**
 * Serial send queue for WhatsApp Web (Selenium shares one Chrome page).
 * concurrency must stay 1 — parallel drv.get/sendKeys corrupt each other.
 */

function createSendQueue({ concurrency = 1 } = {}) {
  if (concurrency !== 1) {
    throw new Error('WhatsApp send queue only supports concurrency=1');
  }

  let active = 0;
  let maxConcurrent = 0;
  let chain = Promise.resolve();
  let queued = 0;
  let lastBrowserQueueWaitMs = 0;
  let lastBrowserOperationMs = 0;

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    queued += 1;
    const enqueuedAt = performance.now();
    const run = chain.then(async () => {
      lastBrowserQueueWaitMs = Math.round(performance.now() - enqueuedAt);
      queued = Math.max(0, queued - 1);
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      const operationStartedAt = performance.now();
      try {
        return await task();
      } finally {
        lastBrowserOperationMs = Math.round(performance.now() - operationStartedAt);
        active -= 1;
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function getStats() {
    return {
      active,
      queued,
      maxConcurrent,
      concurrency: 1,
    };
  }

  function getTimingStats() {
    return {
      browserQueueWaitMs: lastBrowserQueueWaitMs,
      browserOperationMs: lastBrowserOperationMs,
    };
  }

  function resetStats() {
    maxConcurrent = 0;
    lastBrowserQueueWaitMs = 0;
    lastBrowserOperationMs = 0;
  }

  return { enqueue, getStats, getTimingStats, resetStats };
}

module.exports = {
  createSendQueue,
};
