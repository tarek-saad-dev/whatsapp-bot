// Wait briefly for the exact in-flight outbound message to finish building.
 // No plaintext is stored here; no retry send or auth mutation is initiated.
function address(value) {
  const m = /^([0-9]+)(?::[0-9]+)?@(s\.whatsapp\.net|lid)$/.exec(String(value || ''));
  return m ? m[1] + '@' + m[2] : null;
}
export function createPendingRetryBridge(store, { waitMs = 750, maxPending = 8, maxWaiters = 8 } = {}) {
  const pending = new Map();
  let waited = 0, timeouts = 0;
  function reserve(key) {
    const target = address(key?.remoteJid), id = String(key?.id || '');
    if (!target || !id || key?.fromMe !== true || pending.has(id) || pending.size >= maxPending) return () => {};
    const entry = { target, waiters: new Set() };
    pending.set(id, entry);
    return () => {
      if (pending.get(id) !== entry) return;
      pending.delete(id);
      for (const wake of entry.waiters) wake(true);
    };
  }
  async function getMessage(key) {
    const entry = pending.get(String(key?.id || ''));
    if (key?.fromMe !== true || !entry || entry.target !== address(key.remoteJid) || entry.waiters.size >= maxWaiters) {
      return store.getMessage(key);
    }
    waited++;
    const completed = await new Promise(resolve => {
      let timer;
      const wake = result => {
        clearTimeout(timer);
        entry.waiters.delete(wake);
        resolve(result);
      };
      entry.waiters.add(wake);
      timer = setTimeout(() => { timeouts++; wake(false); }, waitMs);
    });
    return completed ? store.getMessage(key) : undefined;
  }
  function clear() {
    for (const entry of pending.values()) for (const wake of entry.waiters) wake(false);
    pending.clear();
  }
  return { reserve, getMessage, clear, stats: () => ({ pending: pending.size, waited, timeouts }) };
}
