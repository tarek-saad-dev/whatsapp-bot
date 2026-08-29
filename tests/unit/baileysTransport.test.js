'use strict';

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    isLiveUpsertType,
    isBlockedRemoteJid,
    isAllowedRemoteJid,
    jidToLegacy,
    phoneFromJid,
    extractText,
    unwrapMessageContent,
    isProtocolOrSystemMessage,
    shouldProcessUpsert,
    mapBaileysInbound,
    buildDedupeKey,
    createLidPhoneCache,
} = require('../../services/transport/baileys/baileysMessageAdapter');
const { createInboxSpool } = require('../../services/inbox/inboxSpool');
const { createBaileysTransport } = require('../../services/transport/baileys/baileysTransport');

function makeInboundMsg({
    id = 'MSG123',
    remoteJid = '201555123456@s.whatsapp.net',
    text = 'hello',
    fromMe = false,
    ts = 1700000000,
    message = null,
} = {}) {
    const body = message || { conversation: text };
    return {
        key: { remoteJid, id, fromMe },
        message: body,
        messageTimestamp: ts,
    };
}

describe('baileysMessageAdapter', () => {
    it('accepts only notify upserts as live traffic', () => {
        expect(isLiveUpsertType('notify')).toBe(true);
        expect(isLiveUpsertType('append')).toBe(false);
        expect(shouldProcessUpsert({ type: 'notify' }).accept).toBe(true);
        expect(shouldProcessUpsert({ type: 'append' }).accept).toBe(false);
    });

    it('ignores fromMe outbound messages', () => {
        const msg = makeInboundMsg({ fromMe: true, text: 'bot sent' });
        const result = mapBaileysInbound(msg);
        expect(result.action).toBe('ignore');
        expect(result.reason).toBe('fromMe');
    });

    it('deduplicates providerMessageId in memory', () => {
        const seen = new Set();
        const msg = makeInboundMsg({ id: 'DUP1', text: 'once' });
        const first = mapBaileysInbound(msg, { seenKeys: seen });
        const second = mapBaileysInbound(msg, { seenKeys: seen });
        expect(first.action).toBe('capture');
        expect(second.action).toBe('duplicate');
    });

    it('normalizes private JID to legacy @c.us phone format', () => {
        expect(jidToLegacy('201555123456@s.whatsapp.net')).toBe('201555123456@c.us');
        expect(phoneFromJid('201555123456@s.whatsapp.net')).toBe('201555123456');
        expect(buildDedupeKey('201555123456@s.whatsapp.net', 'ABC')).toBe('201555123456@c.us|ABC');
    });

    it('ignores groups by default', () => {
        const msg = makeInboundMsg({
            remoteJid: '120363000000000000@g.us',
            text: 'group hello',
        });
        const result = mapBaileysInbound(msg, { includeGroups: false });
        expect(result.action).toBe('ignore');
        expect(result.reason).toBe('blocked_jid');
    });

    it('ignores status and broadcast jids', () => {
        expect(isBlockedRemoteJid('status@broadcast')).toBe(true);
        expect(isAllowedRemoteJid('123@broadcast')).toBe(false);
        expect(isAllowedRemoteJid('newsletter@newsletter')).toBe(false);
    });

    it('ignores unresolved LID-only jids without phone mapping', () => {
        expect(isAllowedRemoteJid('12345678901234@lid')).toBe(false);
        const msg = makeInboundMsg({
            remoteJid: '12345678901234@lid',
            text: 'lid hello',
        });
        const result = mapBaileysInbound(msg);
        expect(result.action).toBe('ignore');
        expect(result.reason).toBe('unresolved_lid');
    });

    it('resolves LID inbound via senderPn on message key', () => {
        const msg = makeInboundMsg({
            id: 'LID1',
            remoteJid: '213262457151524@lid',
            text: 'resolved via sender pn',
        });
        msg.key.senderPn = '201555123456@s.whatsapp.net';
        const result = mapBaileysInbound(msg);
        expect(result.action).toBe('capture');
        expect(result.phone).toBe('201555123456');
        expect(result.remoteJid).toBe('201555123456@c.us');
    });

    it('learns LID mapping from chat pnJid/lidJid', () => {
        const cache = createLidPhoneCache();
        cache.rememberChat({
            id: '213262457151524@lid',
            lidJid: '213262457151524@lid',
            pnJid: '201555123456@s.whatsapp.net',
        }, 'test.chat');
        const msg = makeInboundMsg({
            id: 'LIDCHAT1',
            remoteJid: '213262457151524@lid',
            text: 'from mapped chat',
        });
        const result = mapBaileysInbound(msg, { lidCache: cache });
        expect(result.action).toBe('capture');
        expect(result.phone).toBe('201555123456');
    });

    it('captures inbound notify message into normalized schema', () => {
        const msg = makeInboundMsg({
            id: 'LIVE1',
            remoteJid: '201999888777@s.whatsapp.net',
            text: 'BAILEYS-INTEGRATION-TEST',
        });
        const result = mapBaileysInbound(msg);
        expect(result.action).toBe('capture');
        expect(result.normalized.provider).toBe('whatsapp-web');
        expect(result.normalized.direction).toBe('inbound');
        expect(result.normalized.phone).toBe('201999888777');
        expect(result.normalized.text).toBe('BAILEYS-INTEGRATION-TEST');
    });
});

describe('baileys spool integration', () => {
    let spoolFile;

    beforeEach(() => {
        spoolFile = path.join(os.tmpdir(), `baileys-spool-${Date.now()}-${Math.random()}.json`);
    });

    it('enqueues exactly once and dedupes replays', () => {
        const spool = createInboxSpool({ spoolFile });
        const msg = makeInboundMsg({ id: 'SPOOL1', text: 'queued once' });
        const mapped = mapBaileysInbound(msg);
        expect(mapped.action).toBe('capture');

        spool.capture(mapped.normalized, { timing: { captureLatencyMs: 3 } });
        spool.capture(mapped.normalized, { timing: { captureLatencyMs: 3 } });
        expect(spool.getStats().pending).toBe(1);
        expect(spool.listRecent(10)).toHaveLength(1);
    });
});

describe('baileysTransport reconnect safety', () => {
    it('does not accumulate duplicate messages.upsert listeners across reconnect', async () => {
        class FakeSocket {
            constructor() {
                this.ev = new EventEmitter();
                this.end = async () => {
                    this.ev.emit('connection.update', {
                        connection: 'close',
                        lastDisconnect: { error: { output: { statusCode: 515 } } },
                    });
                };
            }
        }

        const sockets = [];
        const spoolFile = path.join(os.tmpdir(), `baileys-spool-test-${Date.now()}.json`);
        const transport = createBaileysTransport({
            authDir: path.join(os.tmpdir(), `baileys-auth-test-${Date.now()}`),
            spool: createInboxSpool({ spoolFile }),
            logger: { info() {}, warn() {}, error() {} },
            makeSocket: () => {
                const s = new FakeSocket();
                sockets.push(s);
                process.nextTick(() => s.ev.emit('connection.update', { connection: 'open' }));
                return s;
            },
            useAuthState: async () => ({
                state: {},
                saveCreds: async () => {},
            }),
            fetchVersion: async () => ({ version: [2, 3000, 0] }),
        });

        await transport.start();
        expect(transport.getDiagnostics().messagesUpsertListeners).toBe(1);

        await transport.connect();
        expect(transport.getDiagnostics().messagesUpsertListeners).toBe(2);
        expect(sockets).toHaveLength(2);

        const liveSocket = sockets[sockets.length - 1];
        liveSocket.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [makeInboundMsg({ id: 'RECON1', text: 'once after reconnect' })],
        });
        await new Promise((r) => setImmediate(r));

        expect(transport.spool.listRecent(10)).toHaveLength(1);
        await transport.stop();
    });
});
