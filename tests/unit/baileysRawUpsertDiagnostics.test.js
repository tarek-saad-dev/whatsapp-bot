'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildRawUpsertSample } = require('../../services/transport/baileys/baileysMessageAdapter');
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

function captureInboxLogs() {
    const lines = [];
    const original = console.log;
    console.log = (...args) => {
        const line = args.join(' ');
        if (line.startsWith('[inbox]')) lines.push(line);
    };
    return {
        lines,
        restore() {
            console.log = original;
        },
    };
}

function parseInboxLine(line) {
    const match = line.match(/^\[inbox\] (\S+)(.*)$/);
    if (!match) return { event: null, fields: {} };
    const event = match[1];
    const fields = {};
    const fieldRe = /(\w+)=([^\s]+(?:\s(?!\w+=)[^\s]+)*)/g;
    let m;
    const rest = match[2].trim();
    while ((m = fieldRe.exec(rest)) !== null) {
        fields[m[1]] = m[2];
    }
    return { event, fields };
}

class FakeSocket {
    constructor() {
        this.ev = new EventEmitter();
        this.end = async () => {};
    }
}

async function createTestTransport(overrides = {}) {
    const socket = new FakeSocket();
    const spoolFile = path.join(os.tmpdir(), `baileys-raw-${Date.now()}-${Math.random()}.json`);
    const lidMapFile = path.join(os.tmpdir(), `baileys-lid-${Date.now()}-${Math.random()}.json`);
    const transport = createBaileysTransport({
        authDir: path.join(os.tmpdir(), `baileys-auth-raw-${Date.now()}`),
        lidMapFile,
        spool: createInboxSpool({ spoolFile }),
        logger: { info() {}, warn() {}, error() {} },
        makeSocket: (cfg) => {
            overrides.onMakeSocket?.(cfg, socket);
            process.nextTick(() => socket.ev.emit('connection.update', { connection: 'open' }));
            return socket;
        },
        useAuthState: async () => ({
            state: { creds: {} },
            saveCreds: async () => {},
        }),
        fetchVersion: async () => ({ version: [2, 3000, 0] }),
        ...overrides.transportOptions,
    });
    await transport.start();
    await new Promise((r) => setImmediate(r));
    return { transport, socket, spoolFile, lidMapFile };
}

describe('baileys raw upsert diagnostics', () => {
    let logCapture;

    beforeEach(() => {
        logCapture = captureInboxLogs();
    });

    afterEach(() => {
        logCapture.restore();
    });

    it('buildRawUpsertSample exposes safe metadata without message body', () => {
        const msg = makeInboundMsg({
            id: 'RAW1',
            remoteJid: '92449473073158@lid',
            text: 'secret customer text',
        });
        msg.key.senderPn = '201557994946@s.whatsapp.net';
        const sample = buildRawUpsertSample(msg);
        expect(sample.messageId).toBe('RAW1');
        expect(sample.remoteJid).toBe('92449473073158@lid');
        expect(sample.senderPn).toBe('201557994946@s.whatsapp.net');
        expect(sample.fromMe).toBe(false);
        expect(sample.messageKeys).toContain('conversation');
        expect(JSON.stringify(sample)).not.toContain('secret customer text');
    });

    it('logs baileys_raw_upsert before any terminal outcome', async () => {
        const { transport, socket } = await createTestTransport();
        logCapture.lines.length = 0;

        socket.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [makeInboundMsg({ id: 'ORDER1', text: 'probe' })],
        });
        await new Promise((r) => setImmediate(r));

        const events = logCapture.lines.map(parseInboxLine).map((l) => l.event);
        const rawIdx = events.indexOf('baileys_raw_upsert');
        const capturedIdx = events.indexOf('baileys_captured');
        expect(rawIdx).toBeGreaterThanOrEqual(0);
        expect(capturedIdx).toBeGreaterThan(rawIdx);
        await transport.stop();
    });

    it('notify inbound → baileys_captured terminal outcome', async () => {
        const { transport, socket } = await createTestTransport();
        logCapture.lines.length = 0;

        socket.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [makeInboundMsg({ id: 'CAP1', text: 'live notify' })],
        });
        await new Promise((r) => setImmediate(r));

        expect(logCapture.lines.some((l) => l.includes('baileys_captured'))).toBe(true);
        expect(transport.spool.listRecent(10)).toHaveLength(1);
        await transport.stop();
    });

    it('append upsert with content → capture (decrypt-retry / offline path)', async () => {
        const { transport, socket } = await createTestTransport();
        logCapture.lines.length = 0;

        socket.ev.emit('messages.upsert', {
            type: 'append',
            messages: [
                makeInboundMsg({ id: 'APP1', text: 'retry content one' }),
                makeInboundMsg({ id: 'APP2', text: 'retry content two' }),
            ],
        });
        await new Promise((r) => setImmediate(r));

        expect(logCapture.lines.filter((l) => l.includes('baileys_captured'))).toHaveLength(2);
        expect(transport.spool.listRecent(10)).toHaveLength(2);
        await transport.stop();
    });

    it('CIPHERTEXT notify then append content → capture (not permanent decrypt drop)', async () => {
        const prev = process.env.BAILEYS_DECRYPT_PENDING_MS;
        process.env.BAILEYS_DECRYPT_PENDING_MS = '2000';
        try {
            const { transport, socket } = await createTestTransport();
            logCapture.lines.length = 0;

            const cipher = makeInboundMsg({ id: 'DECAPP1', text: 'opaque' });
            cipher.messageStubType = 2;
            socket.ev.emit('messages.upsert', {
                type: 'notify',
                messages: [cipher],
            });
            await new Promise((r) => setImmediate(r));
            expect(logCapture.lines.some((l) => l.includes('baileys_inbound_decrypt_pending'))).toBe(true);
            expect(transport.spool.listRecent(10)).toHaveLength(0);

            socket.ev.emit('messages.upsert', {
                type: 'append',
                messages: [makeInboundMsg({ id: 'DECAPP1', text: 'decrypted body' })],
            });
            await new Promise((r) => setImmediate(r));

            expect(logCapture.lines.some((l) => l.includes('baileys_inbound_decrypt_resolved'))).toBe(true);
            expect(logCapture.lines.some((l) => l.includes('baileys_captured'))).toBe(true);
            expect(transport.spool.listRecent(10)).toHaveLength(1);
            await transport.stop();
        } finally {
            if (prev === undefined) delete process.env.BAILEYS_DECRYPT_PENDING_MS;
            else process.env.BAILEYS_DECRYPT_PENDING_MS = prev;
        }
    });

    it('unresolved LID → pending then quarantine on timeout (not silent drop)', async () => {
        const prev = process.env.BAILEYS_LID_PENDING_MS;
        process.env.BAILEYS_LID_PENDING_MS = '40';
        try {
            const { transport, socket } = await createTestTransport();
            logCapture.lines.length = 0;

            socket.ev.emit('messages.upsert', {
                type: 'notify',
                messages: [makeInboundMsg({
                    id: 'LIDMISS1',
                    remoteJid: '12345678901234@lid',
                    text: 'no mapping',
                })],
            });
            await new Promise((r) => setImmediate(r));

            expect(logCapture.lines.some((l) => l.includes('baileys_inbound_lid_pending'))).toBe(true);
            expect(transport.spool.listRecent(10)).toHaveLength(0);
            expect(transport.getInboxStatus().inboundCapture.pendingLid).toBe(1);

            await new Promise((r) => setTimeout(r, 80));
            expect(logCapture.lines.some((l) =>
                l.includes('baileys_inbound_quarantined')
                && l.includes('reason=unresolved_lid_timeout'),
            )).toBe(true);
            expect(transport.getInboxStatus().inboundCapture.pendingLid).toBe(0);
            expect(transport.getInboxStatus().inboundCapture.quarantined).toBeGreaterThanOrEqual(1);
            await transport.stop();
        } finally {
            if (prev === undefined) delete process.env.BAILEYS_LID_PENDING_MS;
            else process.env.BAILEYS_LID_PENDING_MS = prev;
        }
    });

    it('unresolved LID then mapping arrives → capture (no quarantine)', async () => {
        const prev = process.env.BAILEYS_LID_PENDING_MS;
        process.env.BAILEYS_LID_PENDING_MS = '500';
        try {
            const { transport, socket } = await createTestTransport();
            logCapture.lines.length = 0;

            socket.ev.emit('messages.upsert', {
                type: 'notify',
                messages: [makeInboundMsg({
                    id: 'LIDWAIT1',
                    remoteJid: '213262457151524@lid',
                    text: 'will resolve',
                })],
            });
            await new Promise((r) => setImmediate(r));
            expect(transport.getInboxStatus().inboundCapture.pendingLid).toBe(1);

            transport.lidCache.rememberPn(
                '213262457151524@lid',
                '201555123456@s.whatsapp.net',
                'test.mapping',
            );
            await new Promise((r) => setTimeout(r, 20));

            expect(logCapture.lines.some((l) => l.includes('baileys_inbound_lid_resolved'))).toBe(true);
            expect(logCapture.lines.some((l) => l.includes('baileys_captured'))).toBe(true);
            expect(transport.spool.listRecent(10)).toHaveLength(1);
            expect(transport.getInboxStatus().inboundCapture.pendingLid).toBe(0);
            await transport.stop();
        } finally {
            if (prev === undefined) delete process.env.BAILEYS_LID_PENDING_MS;
            else process.env.BAILEYS_LID_PENDING_MS = prev;
        }
    });

    it('@lid + senderPn → capture and learn mapping', async () => {
        const { transport, socket } = await createTestTransport();
        logCapture.lines.length = 0;
        const msg = makeInboundMsg({
            id: 'LIDPN1',
            remoteJid: '92449473073158@lid',
            text: 'with sender pn',
        });
        msg.key.senderPn = '201557994946@s.whatsapp.net';

        socket.ev.emit('messages.upsert', { type: 'notify', messages: [msg] });
        await new Promise((r) => setImmediate(r));

        expect(logCapture.lines.some((l) => l.includes('baileys_captured'))).toBe(true);
        expect(transport.lidCache.resolvePn('92449473073158@lid')).toContain('201557994946');
        expect(transport.spool.listRecent(10)).toHaveLength(1);
        await transport.stop();
    });

    it('fromMe remains ignored as inbound', async () => {
        const { transport, socket } = await createTestTransport();
        logCapture.lines.length = 0;
        socket.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [makeInboundMsg({ id: 'FROMME1', fromMe: true, text: 'out' })],
        });
        await new Promise((r) => setImmediate(r));
        expect(logCapture.lines.some((l) => l.includes('baileys_captured'))).toBe(false);
        expect(transport.spool.listRecent(10)).toHaveLength(0);
        await transport.stop();
    });

    it('CIPHERTEXT stub → decrypt_pending (not immediate permanent fail)', async () => {
        const prev = process.env.BAILEYS_DECRYPT_PENDING_MS;
        process.env.BAILEYS_DECRYPT_PENDING_MS = '40';
        try {
            const { transport, socket } = await createTestTransport();
            logCapture.lines.length = 0;

            const msg = makeInboundMsg({ id: 'DEC1', text: 'opaque' });
            msg.messageStubType = 2; // StubType.CIPHERTEXT
            socket.ev.emit('messages.upsert', {
                type: 'notify',
                messages: [msg],
            });
            await new Promise((r) => setImmediate(r));

            expect(logCapture.lines.some((l) =>
                l.includes('baileys_inbound_decrypt_pending'),
            )).toBe(true);
            expect(transport.getInboxStatus().inboundCapture.pendingDecrypt).toBeGreaterThanOrEqual(1);
            expect(transport.spool.listRecent(10)).toHaveLength(0);

            await new Promise((r) => setTimeout(r, 80));
            expect(logCapture.lines.some((l) =>
                l.includes('baileys_inbound_quarantined')
                && l.includes('reason=decrypt_timeout'),
            )).toBe(true);
            expect(transport.getInboxStatus().inboundCapture.decryptFailed).toBeGreaterThanOrEqual(1);
            await transport.stop();
        } finally {
            if (prev === undefined) delete process.env.BAILEYS_DECRYPT_PENDING_MS;
            else process.env.BAILEYS_DECRYPT_PENDING_MS = prev;
        }
    });

    it('protocol/system message → baileys_inbound_ignored', async () => {
        const { transport, socket } = await createTestTransport();
        logCapture.lines.length = 0;

        socket.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [makeInboundMsg({
                id: 'PROTO1',
                message: { protocolMessage: { type: 0 } },
            })],
        });
        await new Promise((r) => setImmediate(r));

        expect(logCapture.lines.some((l) =>
            l.includes('baileys_inbound_ignored') && l.includes('reason=protocol_or_system'),
        )).toBe(true);
        await transport.stop();
    });

    it('empty content → baileys_inbound_ignored', async () => {
        const { transport, socket } = await createTestTransport();
        logCapture.lines.length = 0;

        socket.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [makeInboundMsg({
                id: 'EMPTY1',
                message: { conversation: '' },
            })],
        });
        await new Promise((r) => setImmediate(r));

        expect(logCapture.lines.some((l) =>
            l.includes('baileys_inbound_ignored') && l.includes('reason=empty_content'),
        )).toBe(true);
        await transport.stop();
    });

    it('every notify message gets exactly one terminal outcome', async () => {
        const { transport, socket } = await createTestTransport();
        logCapture.lines.length = 0;

        socket.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [
                makeInboundMsg({ id: 'MIX1', text: 'captured' }),
                makeInboundMsg({ id: 'MIX2', remoteJid: '99999999999999@lid', text: 'lid miss' }),
                makeInboundMsg({ id: 'MIX3', fromMe: true, text: 'outbound echo' }),
            ],
        });
        await new Promise((r) => setImmediate(r));

        const terminal = logCapture.lines.filter((l) =>
            l.includes('baileys_captured')
            || l.includes('baileys_inbound_ignored')
            || l.includes('baileys_inbound_lid_pending')
            || l.includes('baileys_inbound_quarantined')
            || l.includes('baileys_upsert_ignored')
            || l.includes('baileys_outbound_observed')
            || l.includes('baileys_outbound_ignored')
            || l.includes('outbound_observed_handler_error'),
        );
        expect(terminal.length).toBeGreaterThanOrEqual(3);
        expect(terminal.some((l) => l.includes('MIX3') || l.includes('outbound'))).toBe(true);
        expect(terminal.some((l) => l.includes('lid_pending') || l.includes('LID') || l.includes('99999999999999'))).toBe(true);
        await transport.stop();
    });

    it('reconnect leaves exactly one live current-socket upsert listener', async () => {
        const sockets = [];
        const spoolFile = path.join(os.tmpdir(), `baileys-recon-raw-${Date.now()}.json`);
        const transport = createBaileysTransport({
            authDir: path.join(os.tmpdir(), `baileys-auth-recon-${Date.now()}`),
            spool: createInboxSpool({ spoolFile }),
            logger: { info() {}, warn() {}, error() {} },
            makeSocket: () => {
                const s = new FakeSocket();
                sockets.push(s);
                process.nextTick(() => s.ev.emit('connection.update', { connection: 'open' }));
                return s;
            },
            useAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
            fetchVersion: async () => ({ version: [2, 3000, 0] }),
        });

        await transport.start();
        const diag1 = transport.getDiagnostics();
        expect(diag1.currentSocketListeners.messagesUpsert).toBe(1);
        expect(diag1.messagesUpsertListenersTotal).toBe(1);

        await transport.connect();
        const diag2 = transport.getDiagnostics();
        expect(diag2.currentSocketListeners.messagesUpsert).toBe(1);
        expect(diag2.currentSocketListeners.messagesUpdate).toBe(1);
        expect(diag2.currentSocketListeners.messageReceipt).toBe(1);
        expect(diag2.messagesUpsertListenersTotal).toBe(2);

        await transport.stop();
    });
});
