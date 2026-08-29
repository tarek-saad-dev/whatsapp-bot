'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('transport config', () => {
    const envBackup = process.env.WHATSAPP_TRANSPORT;

    afterEach(() => {
        if (envBackup === undefined) {
            delete process.env.WHATSAPP_TRANSPORT;
        } else {
            process.env.WHATSAPP_TRANSPORT = envBackup;
        }
        vi.resetModules();
    });

    it('defaults to selenium', () => {
        delete process.env.WHATSAPP_TRANSPORT;
        vi.resetModules();
        const { getTransportMode } = require('../../services/transport/config');
        expect(getTransportMode()).toBe('selenium');
    });

    it('accepts baileys transport', () => {
        process.env.WHATSAPP_TRANSPORT = 'baileys';
        vi.resetModules();
        const { getTransportMode, isBaileysTransport } = require('../../services/transport/config');
        expect(getTransportMode()).toBe('baileys');
        expect(isBaileysTransport()).toBe(true);
    });

    it('rejects invalid transport values', () => {
        process.env.WHATSAPP_TRANSPORT = 'websocket';
        vi.resetModules();
        const { getTransportMode } = require('../../services/transport/config');
        expect(() => getTransportMode()).toThrow(/Invalid WHATSAPP_TRANSPORT/);
    });
});

describe('whatsappService transport selection', () => {
    const envBackup = process.env.WHATSAPP_TRANSPORT;

    afterEach(() => {
        if (envBackup === undefined) {
            delete process.env.WHATSAPP_TRANSPORT;
        } else {
            process.env.WHATSAPP_TRANSPORT = envBackup;
        }
        vi.resetModules();
    });

    it('loads selenium implementation by default', () => {
        delete process.env.WHATSAPP_TRANSPORT;
        vi.resetModules();
        const svc = require('../../services/whatsappService');
        expect(svc.getTransportMode()).toBe('selenium');
        expect(typeof svc.listWhatsAppPageTargets).toBe('function');
    });

    it('loads baileys implementation when configured', async () => {
        process.env.WHATSAPP_TRANSPORT = 'baileys';
        vi.resetModules();
        const svc = require('../../services/whatsappService');
        expect(svc.getTransportMode()).toBe('baileys');
        expect(await svc.isDebugPortActive()).toBe(false);
        expect(await svc.listWhatsAppPageTargets()).toEqual([]);
    });
});
