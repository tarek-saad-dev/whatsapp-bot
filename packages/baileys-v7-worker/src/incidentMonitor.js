// Observational, per-account, bounded incident tracking. No application sends or auth changes.
export function detectConditions({ state, socketRecovery, peerCryptoHealth, inboundDelivery } = {}) {
  const issues = [];
  if (state === 'ERROR' && ['RETRY_EXHAUSTED', 'OPERATOR_REVIEW'].includes(socketRecovery?.action)) issues.push('SOCKET_REVIEW');
  if (['DISCONNECTED', 'CONNECTING'].includes(state) && socketRecovery?.action === 'RETRY_SCHEDULED') issues.push('SOCKET_RECONNECTING');
  if (state === 'READY') {
    if (['DEGRADED', 'SUSPECT'].includes(peerCryptoHealth?.status)) issues.push('PEER_CRYPTO');
    if (peerCryptoHealth?.status === 'TRAFFIC_RESUMED_WITH_UNRESOLVED_MESSAGES') issues.push('PEER_CRYPTO_UNRESOLVED');
    if (inboundDelivery?.running === false) issues.push('INBOUND_WORKER_STOPPED');
    if (Number(inboundDelivery?.pending) > 0 && inboundDelivery?.lastErrorCode) issues.push('INBOUND_DELIVERY_ERROR');
  }
  return issues;
}
export function createIncidentMonitor({ now = Date.now, graceMs = 30_000, maxRecent = 20, onTransition = () => {}, load = () => null, save = () => {} } = {}) {
  const active = new Map(), candidates = new Map(), recent = [];
  let lastSampleAt = null, dirty = false, persistence = 'OK';
  const iso = t => new Date(t).toISOString();
  const known = new Set(['SOCKET_REVIEW','SOCKET_RECONNECTING','PEER_CRYPTO','PEER_CRYPTO_UNRESOLVED','INBOUND_WORKER_STOPPED','INBOUND_DELIVERY_ERROR']);
  const validTime = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
  function clean(value, interrupted = false) {
    if (!value || !known.has(value.issue) || !validTime(value.startedAt)) return null;
    const start = Date.parse(value.startedAt);
    const end = interrupted ? Math.max(start, Math.min(now(), Date.parse(value.lastObservedAt))) : Date.parse(value.endedAt);
    if (!Number.isFinite(end) || end < start) return null;
    const outcome = interrupted ? 'OBSERVATION_INTERRUPTED' : value.outcome;
    if (!['OBSERVATION_INTERRUPTED','CONDITION_NO_LONGER_OBSERVED'].includes(outcome)) return null;
    return { issue: value.issue, startedAt: iso(start), endedAt: iso(end), durationMs: end - start, outcome };
  }
  try {
    const prior = load();
    if (prior) {
      for (const item of (Array.isArray(prior.recent) ? prior.recent : []).slice(-maxRecent)) {
        const entry = clean(item); if (entry) recent.push(entry);
      }
      for (const item of (Array.isArray(prior.active) ? prior.active : []).slice(0, known.size)) {
        const entry = clean(item, true); if (entry) recent.push(entry);
      }
      while (recent.length > maxRecent) recent.shift();
      dirty = true;
    }
  } catch { persistence = 'READ_ERROR'; }
  function persist() {
    if (!dirty && !active.size) return;
    // A read error is not permission to overwrite a possibly recoverable journal.
    if (persistence === 'READ_ERROR') return;
    try {
      save({ version: 1, active: [...active].map(([issue, started]) => ({ issue, startedAt: iso(started), lastObservedAt: lastSampleAt })), recent: recent.map(e => ({ ...e })) });
      dirty = false; persistence = 'OK';
    } catch { persistence = 'WRITE_ERROR'; dirty = true; }
  }
  function transition(value) { dirty = true; try { onTransition(value); } catch { /* monitoring must not interrupt the runtime */ } }
  function sample(signals) {
    const t = now();
    lastSampleAt = iso(t);
    const observed = new Set(detectConditions(signals));
    for (const issue of candidates.keys()) if (!observed.has(issue)) candidates.delete(issue);
    for (const [issue, started] of active) {
      if (observed.has(issue)) continue;
      active.delete(issue);
      const entry = { issue, startedAt: iso(started), endedAt: iso(t), durationMs: Math.max(0, t - started), outcome: 'CONDITION_NO_LONGER_OBSERVED' };
      recent.push(entry);
      while (recent.length > maxRecent) recent.shift();
      transition({ event: 'closed', ...entry });
    }
    for (const issue of observed) {
      if (active.has(issue)) continue;
      if (!candidates.has(issue)) candidates.set(issue, t);
      const started = candidates.get(issue);
      if (issue !== 'SOCKET_REVIEW' && t - started < graceMs) continue;
      candidates.delete(issue);
      active.set(issue, started);
      transition({ event: 'opened', issue, startedAt: iso(started), observedAt: iso(t) });
    }
    persist();
  }
  function snapshot() {
    const t = now();
    return { lastSampleAt, persistence, active: [...active].map(([issue, started]) => ({ issue, startedAt: iso(started), durationMs: Math.max(0, t - started) })), recent: recent.map(e => ({ ...e })) };
  }
  return { sample, snapshot };
}
