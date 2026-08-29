'use strict';

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    createOutboundMessageStore,
    DEFAULT_MAX_ENTRIES,
} = require('../../services/transport/baileys/outboundMessageStore');
const { resolveOutboundJid } = require('../../services/transport/baileys/resolveOutboundJid');
const {
    isLibsignalSessionDump,
    recordSafeSessionChurn,
    getSessionChurnStats,
    _resetCountersForTests,
} = require('../../services/transport/baileys/silenceLibsignalSessionLogs');
const { createLidPhoneCache } = require('../../services/transport/baileys/baileysMessageAdapter');

describe('outboundMessageStore (Baileys getMessage)', () => {
    it('returns stored outbound content for send key', async () => {
        const store = createOutboundMessageStore();
        const key = {
            remoteJid: '92449473073158@lid',
            fromMe: true,
            id: '3EB0TESTMSG001',
        };
        const message = { conversation: 'hello retry' };
        expect(store.put(key, message)).toBe(true);
        const got = await store.getMessage(key);
        expect(got).toEqual({ conversation: 'hello retry' });
        expect(store.getStats().hits).toBe(1);
    });

    it('returns undefined for unknown keys', async () => {
        const store = createOutboundMessageStore();
        const got = await store.getMessage({
            remoteJid: '201557994946@s.whatsapp.net',
            fromMe: true,
            id: 'UNKNOWN_ID',
        });
        expect(got).toBeUndefined();
        expect(store.getStats().misses).toBe(1);
    });

    it('enforces bounded retention and removes oldest safely', () => {
        const store = createOutboundMessageStore({ maxEntries: 3, ttlMs: 60_000 });
        for (let i = 0; i < 5; i += 1) {
            store.put(
                { id: `ID${i}`, remoteJid: '201555@s.whatsapp.net', fromMe: true },
                { conversation: `m${i}` },
            );
        }
        expect(store.size()).toBe(3);
        expect(store.get({ id: 'ID0' })).toBeUndefined();
        expect(store.get({ id: 'ID1' })).toBeUndefined();
        expect(store.get({ id: 'ID2' })).toEqual({ conversation: 'm2' });
        expect(store.get({ id: 'ID4' })).toEqual({ conversation: 'm4' });
        expect(store.maxEntries).toBe(3);
        expect(DEFAULT_MAX_ENTRIES).toBe(256);
    });

    it('expires entries by TTL', () => {
        let now = 1_000_000;
        const store = createOutboundMessageStore({
            maxEntries: 10,
            ttlMs: 1000,
            now: () => now,
        });
        store.put({ id: 'OLD', fromMe: true }, { conversation: 'old' });
        now += 1001;
        expect(store.get({ id: 'OLD' })).toBeUndefined();
    });
});

describe('resolveOutboundJid', () => {
    it('routes known phone to known @lid', () => {
        const cache = createLidPhoneCache();
        cache.rememberPn(
            '92449473073158@lid',
            '201557994946@s.whatsapp.net',
            'test',
        );
        const dest = resolveOutboundJid('201557994946', cache);
        expect(dest.ok).toBe(true);
        expect(dest.route).toBe('lid');
        expect(dest.jid).toBe('92449473073158@lid');
    });

    it('routes unknown phone to PN @s.whatsapp.net', () => {
        const cache = createLidPhoneCache();
        const dest = resolveOutboundJid('201555000111', cache);
        expect(dest.ok).toBe(true);
        expect(dest.route).toBe('pn');
        expect(dest.jid).toBe('201555000111@s.whatsapp.net');
    });

    it('does not fabricate LID from digits', () => {
        const dest = resolveOutboundJid('201557994946', createLidPhoneCache());
        expect(dest.jid).toBe('201557994946@s.whatsapp.net');
        expect(dest.lidJid).toBeNull();
    });
});

describe('libsignal sensitive session log silence', () => {
    it('detects SessionEntry dump prefixes', () => {
        expect(isLibsignalSessionDump(['Closing session:', { privKey: 'x' }])).toBe(true);
        expect(isLibsignalSessionDump(['Session already closed', { rootKey: 'y' }])).toBe(true);
        expect(isLibsignalSessionDump(['[baileys] READY'])).toBe(false);
    });

    it('records only non-secret churn metadata', () => {
        _resetCountersForTests();
        const safe = [];
        recordSafeSessionChurn(
            ['Closing session:', {
                privKey: Buffer.from('secret'),
                rootKey: Buffer.from('secret2'),
                ephemeralKeyPair: { privKey: 'nope' },
                chainKey: 'nope',
            }],
            {
                info: (...args) => safe.push(args),
            },
        );
        expect(safe).toHaveLength(1);
        expect(safe[0][0]).toBe('[baileys] signal_session_churn');
        expect(JSON.stringify(safe[0])).not.toMatch(/privKey|rootKey|ephemeralKeyPair|chainKey|messageKeys/);
        expect(getSessionChurnStats().sessionCloseCount).toBe(1);
    });
});
