'use strict';

/**
 * Bounded outbound message store for Baileys getMessage retries.
 *
 * Baileys 6.7.22 contract (lib/Types/Socket.d.ts):
 *   getMessage: (key: proto.IMessageKey) => Promise<proto.IMessage | undefined>
 *
 * Used by messages-recv sendMessagesAgain to re-relay plaintext when a peer
 * cannot decrypt ("Waiting for this message. This may take a while.").
 *
 * Persistence across process restart is NOT required by Baileys source:
 * msgRetryCounterCache is an in-memory NodeCache (MSG_RETRY TTL = 1 hour) and
 * getMessage is invoked on the live socket while handling retry receipts.
 * This store mirrors that lifetime (in-memory, TTL + max entries).
 */

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // matches Baileys DEFAULT_CACHE_TTLS.MSG_RETRY

function createOutboundMessageStore({
    maxEntries = DEFAULT_MAX_ENTRIES,
    ttlMs = DEFAULT_TTL_MS,
    now = () => Date.now(),
} = {}) {
    const entries = new Map(); // id -> { message, remoteJid, fromMe, storedAt }
    let hits = 0;
    let misses = 0;
    let evictions = 0;

    function keyId(key) {
        return String(key && key.id != null ? key.id : '').trim();
    }

    function purgeExpired(ts = now()) {
        for (const [id, entry] of entries) {
            if (ts - entry.storedAt > ttlMs) {
                entries.delete(id);
                evictions += 1;
            }
        }
    }

    function enforceBound() {
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            if (oldest == null) break;
            entries.delete(oldest);
            evictions += 1;
        }
    }

    function put(key, message) {
        const id = keyId(key);
        if (!id || !message || typeof message !== 'object') return false;

        // Store only proto message content — never Signal/session/auth material.
        const stored = {
            message: { ...message },
            remoteJid: key.remoteJid ? String(key.remoteJid) : null,
            fromMe: key.fromMe == null ? true : Boolean(key.fromMe),
            storedAt: now(),
        };

        if (entries.has(id)) entries.delete(id);
        entries.set(id, stored);
        purgeExpired();
        enforceBound();
        return true;
    }

    function get(key) {
        purgeExpired();
        const id = keyId(key);
        if (!id) {
            misses += 1;
            return undefined;
        }
        const entry = entries.get(id);
        if (!entry) {
            misses += 1;
            return undefined;
        }
        // Refresh LRU order
        entries.delete(id);
        entries.set(id, entry);
        hits += 1;
        return entry.message;
    }

    async function getMessage(key) {
        return get(key);
    }

    function size() {
        purgeExpired();
        return entries.size;
    }

    function getStats() {
        purgeExpired();
        return {
            size: entries.size,
            maxEntries,
            ttlMs,
            hits,
            misses,
            evictions,
            persistence: 'memory',
        };
    }

    function clear() {
        entries.clear();
    }

    return {
        put,
        get,
        getMessage,
        size,
        getStats,
        clear,
        maxEntries,
        ttlMs,
    };
}

module.exports = {
    createOutboundMessageStore,
    DEFAULT_MAX_ENTRIES,
    DEFAULT_TTL_MS,
};
