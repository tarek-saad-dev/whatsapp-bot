// Socket-only recovery. Never sends application messages or changes stored auth.
const transient = new Set([408, 428, 503, 515]);
export function createReconnectPolicy({ now = Date.now, maxAttempts = 6, stableMs = 60_000 } = {}) {
  let attempts = 0, openedAt = null, last = 'IDLE';
  function opened() { if (openedAt === null) openedAt = now(); last = 'CONNECTED'; }
  function closed(code) {
    if (openedAt !== null && now() - openedAt >= stableMs) attempts = 0;
    openedAt = null;
    if (code === 401) { last = 'LOGGED_OUT'; return { action: last }; }
    if (!transient.has(code)) { last = 'OPERATOR_REVIEW'; return { action: last }; }
    if (attempts >= maxAttempts) { last = 'RETRY_EXHAUSTED'; return { action: last }; }
    attempts++;
    last = 'RETRY_SCHEDULED';
    return { action: last, delayMs: Math.min(30_000, 1000 * 2 ** (attempts - 1)) };
  }
  function startFailed() { last = 'OPERATOR_REVIEW'; }
  function stopped() { openedAt = null; last = 'STOPPED'; }
  function snapshot() { return { action: last, attempts: openedAt !== null && now() - openedAt >= stableMs ? 0 : attempts, maxAttempts }; }
  return { opened, closed, startFailed, stopped, snapshot };
}
