'use strict';

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    mapBaileysOutboundObserved,
    createLidPhoneCache,
    mapBaileysInbound,
} = require('../../services/transport/baileys/baileysMessageAdapter');
const {
    createOutboundObservedPoster,
    resolveOutboundObservedUrl,
} = require('../../services/inbox/outboundObservedPoster');

function makeOutboundMsg({
    remoteJid = '201555123456@s.whatsapp.net',
    id = 'OUT1',
    text = 'أهلاً',
    fromMe = true,
    senderPn = null,
} = {}) {
    return {
        key: { remoteJid, id, fromMe, ...(senderPn ? { senderPn } : {}) },
        message: { conversation: text },
        messageTimestamp: 1720000000,
    };
}

describe('mapBaileysOutboundObserved', () => {
    it('forwards fromMe customer chat with phone', () => {
        const seen = new Set();
        const result = mapBaileysOutboundObserved(makeOutboundMsg(), { seenOutboundKeys: seen });
        expect(result.action).toBe('observe');
        expect(result.phone).toBe('201555123456');
        expect(result.payload.providerMessageId).toBe('OUT1');
        expect(result.payload.rawPayload.baileysKey.fromMe).toBe(true);
    });

    it('ignores inbound (not fromMe)', () => {
        const result = mapBaileysOutboundObserved(makeOutboundMsg({ fromMe: false }));
        expect(result.action).toBe('ignore');
        expect(result.reason).toBe('not_fromMe');
    });

    it('ignores status/broadcast and groups', () => {
        expect(
            mapBaileysOutboundObserved(makeOutboundMsg({ remoteJid: 'status@broadcast' })).reason,
        ).toBe('blocked_jid');
        expect(
            mapBaileysOutboundObserved(makeOutboundMsg({ remoteJid: '120363@g.us' })).reason,
        ).toBe('group');
    });

    it('resolves LID → phone via cache (same identity as inbound)', () => {
        const lidCache = createLidPhoneCache();
        lidCache.rememberPn('92449473073158@lid', '201555999888@s.whatsapp.net', 'test');
        const outbound = mapBaileysOutboundObserved(
            makeOutboundMsg({
                remoteJid: '92449473073158@lid',
                id: 'LIDOUT1',
                text: 'manual',
            }),
            { lidCache },
        );
        expect(outbound.action).toBe('observe');
        expect(outbound.phone).toBe('201555999888');

        const inbound = mapBaileysInbound(
            {
                key: {
                    remoteJid: '92449473073158@lid',
                    id: 'LIDIN1',
                    fromMe: false,
                },
                message: { conversation: 'hi' },
                messageTimestamp: 1720000001,
            },
            { lidCache },
        );
        expect(inbound.action).toBe('capture');
        expect(inbound.phone).toBe('201555999888');
        expect(outbound.phone).toBe(inbound.phone);
    });

    it('resolves LID via senderPn on the key', () => {
        const lidCache = createLidPhoneCache();
        const result = mapBaileysOutboundObserved(
            makeOutboundMsg({
                remoteJid: '111222333@lid',
                senderPn: '201555111222@s.whatsapp.net',
                id: 'SPN1',
            }),
            { lidCache },
        );
        expect(result.action).toBe('observe');
        expect(result.phone).toBe('201555111222');
    });

    it('dedupes outbound keys', () => {
        const seen = new Set();
        const msg = makeOutboundMsg({ id: 'DUPOUT' });
        expect(mapBaileysOutboundObserved(msg, { seenOutboundKeys: seen }).action).toBe('observe');
        expect(mapBaileysOutboundObserved(msg, { seenOutboundKeys: seen }).action).toBe('duplicate');
    });
});

describe('outboundObservedPoster', () => {
    it('derives Cashier URL from inbox webhook', () => {
        expect(
            resolveOutboundObservedUrl({
                inboxUrl: 'https://ops.example/api/internal/messaging/inbox/whatsapp',
            }),
        ).toBe('https://ops.example/api/internal/messaging/outbound-observed/whatsapp');
    });

    it('posts with bearer, retries once, never throws', async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(new Error('down'))
            .mockResolvedValueOnce({
                status: 200,
                json: async () => ({ ok: true }),
            });
        const poster = createOutboundObservedPoster({
            webhookUrl: 'https://ops.example/api/internal/messaging/outbound-observed/whatsapp',
            webhookToken: 'secret',
            timeoutMs: 1000,
            fetchImpl,
        });
        const result = await poster.observe({
            provider: 'whatsapp-web',
            providerMessageId: 'P1',
            phone: '201555123456',
            text: null,
            occurredAt: new Date().toISOString(),
        });
        expect(result.ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    });

    it('local-dedupes providerMessageId', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            status: 200,
            json: async () => ({ ok: true }),
        });
        const poster = createOutboundObservedPoster({
            webhookUrl: 'https://ops.example/x',
            fetchImpl,
        });
        await poster.observe({ providerMessageId: 'SAME' });
        const second = await poster.observe({ providerMessageId: 'SAME' });
        expect(second.duplicateLocal).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
