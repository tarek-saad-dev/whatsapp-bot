// Account-local diagnostic state. Never resends a message or mutates credentials.
// Exact normalized private JID; no speculative PN/LID identity merges.
function peerKey(value) {
  const m = /^([0-9]+)(?::[0-9]+)?@(s\.whatsapp\.net|lid)$/.exec(String(value || ''));
  return m ? m[1] + '@' + m[2] : null;
}
export function createPeerCryptoHealth({ now = Date.now, ttlMs = 30 * 60_000, maxPeers = 512, maxIds = 32 } = {}) {
  const peers = new Map();
  let connected = false, recoveredEpisodes = 0, recoveredMessages = 0, evictedPeers = 0;
  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [peer, episode] of peers) if (episode.lastFailure <= cutoff) peers.delete(peer);
  }
  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    peers.clear();
  }
  function observe({ key, type, summary }) {
    const peer = peerKey(key?.remoteJid);
    if (!connected || type !== 'notify' || key?.fromMe !== false || !peer || !key?.id) return false;
    const id = String(key.id);
    sweep();
    let episode = peers.get(peer);
    // Only explicit ciphertext stub counts. Media, unknown protocol events and
    // missing text are not evidence of a decryption error.
    if (summary?.plaintextPresent === 'YES' && summary?.textLength > 0) {
      if (!episode) return false;
      if (episode.failedIds.delete(id)) recoveredMessages++;
      if (!episode.failedIds.size && !episode.overflow) {
        peers.delete(peer);
        recoveredEpisodes++;
      } else {
        episode.resumed = true;
      }
      return true;
    }
    if (summary?.stubType !== 2 || summary?.plaintextPresent === 'YES') return false;
    if (!episode) {
      episode = { failedIds: new Set(), lastFailure: now(), resumed: false, overflow: false };
      peers.set(peer, episode);
    }
    if (!episode.failedIds.has(id) && episode.failedIds.size >= maxIds) episode.overflow = true;
    else episode.failedIds.add(id);
    episode.lastFailure = now();
    episode.resumed = false;
    while (peers.size > maxPeers) {
      peers.delete(peers.keys().next().value);
      evictedPeers++;
    }
    return true;
  }
  function snapshot() {
    sweep();
    let suspectPeers = 0, degradedPeers = 0, resumedPeers = 0, overflowPeers = 0;
    for (const e of peers.values()) {
      if (e.overflow) overflowPeers++;
      if (e.resumed) resumedPeers++;
      else if (e.failedIds.size >= 2 || e.overflow) degradedPeers++;
      else suspectPeers++;
    }
    return {
      status: !connected ? 'NOT_CONNECTED' : degradedPeers ? 'DEGRADED' : suspectPeers ? 'SUSPECT' : resumedPeers ? 'TRAFFIC_RESUMED_WITH_UNRESOLVED_MESSAGES' : 'NO_ACTIVE_FAILURE_OBSERVED',
      suspectPeers, degradedPeers, resumedPeers, overflowPeers, recoveredEpisodes, recoveredMessages, evictedPeers,
    };
  }
  return { setConnected, observe, snapshot };
}
