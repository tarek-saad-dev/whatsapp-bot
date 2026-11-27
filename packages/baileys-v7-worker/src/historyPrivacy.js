// Account-specific consent. Unknown/error never authorizes historical data.
export function createHistoryPrivacyPolicy({
  accountKey, baseUrl, token, enabled = true, ttlMs = 5000,
  fetchFn = globalThis.fetch, now = Date.now,
}) {
  let state = 'unknown';
  let privatePhones = null;
  let removedPhones = null;
  let mode = null;
  let approvedPhones = null;
  let expiresAt = 0;
  let resetAt = null;
  let inFlight = null;
  function valid() {
    return now() < expiresAt && privatePhones !== null && mode !== null && approvedPhones !== null && state !== 'unknown';
  }
  function current() {
    if (!valid()) return 'unknown';
    return enabled ? state : 'fresh';
  }
  async function get({ force = false } = {}) {
    if (!token || !accountKey) return 'unknown';
    if (!force && now() < expiresAt) return current();
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
        privatePhones = Array.isArray(body.privateContactPhones) && body.privateContactPhones.length <= 1100 &&
          body.privateContactPhones.every(p => typeof p === 'string' && /^[1-9]\d{7,14}$/.test(p))
          ? body.privateContactPhones : null;
        removedPhones = Array.isArray(body.removedContactPhones) && body.removedContactPhones.length<=1000 && body.removedContactPhones.every(p=>typeof p==='string' && /^[1-9]\d{7,14}$/.test(p) && privatePhones?.includes(p)) ? body.removedContactPhones : null;
        mode = ['ALL', 'BUSINESS_ONLY', 'MANUAL'].includes(body.mode) ? body.mode : null;
        approvedPhones = Array.isArray(body.approvedContactPhones) && body.approvedContactPhones.length <= 1000 &&
          body.approvedContactPhones.every(p => typeof p === 'string' && /^[1-9]\d{7,14}$/.test(p)) ? body.approvedContactPhones : null;
        resetAt = body.resetAtUtc == null ? null : Date.parse(body.resetAtUtc);
        if (resetAt !== null && !Number.isFinite(resetAt)) throw new Error('INVALID_RESET');
        state = body.historyImportEnabled === true && resetAt === null ? 'allow'
          : body.historyImportEnabled === false || resetAt !== null ? 'fresh' : 'unknown';
      } catch {
        state = 'unknown';
        privatePhones = null;
        removedPhones = null;
        mode = null;
        approvedPhones = null;
        resetAt = null;
      }
      expiresAt = now() + ttlMs;
      return current();
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  function contactAllowed(key) {
    if (!valid()) return false;
    if (!privatePhones.length && mode !== 'BUSINESS_ONLY') return true;
    const match = /^\+?([1-9]\d{7,14})(?:@(?:s\.whatsapp\.net|c\.us))?$/i.exec(String(key || ''));
    return Boolean(match && !privatePhones.includes(match[1]) &&
      (mode !== 'BUSINESS_ONLY' || approvedPhones.includes(match[1])));
  }
  function metadataAllowed() {
    return valid() && privatePhones.length === 0 && mode !== 'BUSINESS_ONLY';
  }
  // Do not treat an outage, unresolved identity or unapproved business-only
  // contact as consent to erase a queue. Only an explicit block qualifies.
  function explicitlyBlocked(key) {
    if (!valid()) return false;
    const match = /^\+?([1-9]\d{7,14})(?:@(?:s\.whatsapp\.net|c\.us))?$/i.exec(String(key || ''));
    return Boolean(match && privatePhones.includes(match[1]));
  }
  // OTP is the exact server-generated verification template and a reserved
  // idempotency namespace on the bearer-authenticated managed send endpoint.
  function outboundAllowed(key,idempotencyKey,text) {
    if(!valid())return false;
    const match=/^\+?([1-9]\d{7,14})$/.exec(String(key||''));
    if(!match||privatePhones.includes(match[1]))return false;
    if(mode!=='BUSINESS_ONLY'||approvedPhones.includes(match[1]))return true;
    return /^otp:[0-9a-f-]{36}:.+$/i.test(String(idempotencyKey||'')) &&
      /^رمز التحقق الخاص بك في (?:CUT CLUB|حسابك): \*\d{6}\*\nصالح لمدة 5 دقائق\. لا تشارك الرمز مع أي شخص\.\nإذا لم تطلب الرمز، تجاهل هذه الرسالة\.$/u.test(String(text||''));
  }
  function explicitlyRemoved(key){
    if(!valid()||!removedPhones)return false;
    const match=/^\+?([1-9]\d{7,14})(?:@(?:s\.whatsapp\.net|c\.us))?$/i.exec(String(key||''));
    return Boolean(match&&removedPhones.includes(match[1]));
  }
  function beforeReset(occurredAt, historical=false) {
    if (!valid() || resetAt === null) return false;
    const at = typeof occurredAt === 'number' ? (occurredAt < 1e12 ? occurredAt * 1000 : occurredAt) : Date.parse(occurredAt || '');
    return historical || !Number.isFinite(at) || at < resetAt;
  }
  return { get, current, contactAllowed, metadataAllowed, explicitlyBlocked, explicitlyRemoved, outboundAllowed, beforeReset };
}

export function allowsMirrorEvent(event, policy) {
  return policy === 'allow' || (event?.kind === 'message' && event.historical === false);
}

export function allowsMediaEvent(event, policy) {
  // Old journals have no historical marker. Never assume those entries are live.
  return policy === 'allow' || event?.historical === false;
}
