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
export function createIncidentMonitor({ now = Date.now, graceMs = 30_000, maxRecent = 20, onTransition = () => {} } = {}) {
  const active = new Map(), candidates = new Map(), recent = [];
  let lastSampleAt = null;
  const iso = t => new Date(t).toISOString();
  function transition(value) { try { onTransition(value); } catch { /* monitoring must not interrupt the runtime */ } }
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
  }
  function snapshot() {
    const t = now();
    return { lastSampleAt, active: [...active].map(([issue, started]) => ({ issue, startedAt: iso(started), durationMs: Math.max(0, t - started) })), recent: recent.map(e => ({ ...e })) };
  }
  return { sample, snapshot };
}
