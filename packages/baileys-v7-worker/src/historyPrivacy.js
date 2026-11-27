// Account-specific consent. Unknown/error never authorizes historical data.
export function createHistoryPrivacyPolicy({
  accountKey, baseUrl, token, enabled = true, ttlMs = 5000,
  fetchFn = globalThis.fetch, now = Date.now,
}) {
  let state = 'unknown';
  let expiresAt = 0;
  let inFlight = null;
  function current() {
    if (!enabled) return 'fresh';
    return now() < expiresAt ? state : 'unknown';
  }
  async function get({ force = false } = {}) {
    if (!enabled) return 'fresh';
    if (!token || !accountKey) return 'unknown';
    if (!force && now() < expiresAt) return state;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const response = await fetchFn(String(baseUrl).replace(/[/]+$/, '') + '/api/runtime/whatsapp/privacy', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountKey }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('POLICY_UNAVAILABLE');
        const body = await response.json();
        state = body.historyImportEnabled === true ? 'allow'
          : body.historyImportEnabled === false ? 'fresh' : 'unknown';
      } catch {
        state = 'unknown';
      }
      expiresAt = now() + ttlMs;
      return state;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  return { get, current };
}

export function allowsMirrorEvent(event, policy) {
  return policy === 'allow' || (event?.kind === 'message' && event.historical === false);
}

export function allowsMediaEvent(event, policy) {
  // Old journals have no historical marker. Never assume those entries are live.
  return policy === 'allow' || event?.historical === false;
}
