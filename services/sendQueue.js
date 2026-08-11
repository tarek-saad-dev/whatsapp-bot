'use strict';

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

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    queued += 1;
    const run = chain.then(async () => {
      queued = Math.max(0, queued - 1);
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      try {
        return await task();
      } finally {
        active -= 1;
      }
    });
    // Keep the chain alive after failures so later jobs still run.
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

  function resetStats() {
    maxConcurrent = 0;
  }

  return { enqueue, getStats, resetStats };
}

module.exports = {
  createSendQueue,
};
