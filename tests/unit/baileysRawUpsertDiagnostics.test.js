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
    const transport = createBaileysTransport({
        authDir: path.join(os.tmpdir(), `baileys-auth-raw-${Date.now()}`),
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
    return { transport, socket, spoolFile };
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

    it('append upsert → baileys_upsert_ignored per message', async () => {
        const { transport, socket } = await createTestTransport();
        logCapture.lines.length = 0;

        socket.ev.emit('messages.upsert', {
            type: 'append',
            messages: [
                makeInboundMsg({ id: 'APP1', text: 'history one' }),
                makeInboundMsg({ id: 'APP2', text: 'history two' }),
            ],
        });
        await new Promise((r) => setImmediate(r));

        const ignored = logCapture.lines.filter((l) => l.includes('baileys_upsert_ignored'));
        expect(ignored).toHaveLength(2);
        expect(ignored.every((l) => l.includes('reason=not_live_notify'))).toBe(true);
        expect(transport.spool.listRecent(10)).toHaveLength(0);
        await transport.stop();
    });

    it('unresolved LID → baileys_inbound_ignored', async () => {
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

        expect(logCapture.lines.some((l) =>
            l.includes('baileys_inbound_ignored') && l.includes('reason=unresolved_lid'),
        )).toBe(true);
        await transport.stop();
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
            || l.includes('baileys_upsert_ignored'),
        );
        expect(terminal).toHaveLength(3);
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
