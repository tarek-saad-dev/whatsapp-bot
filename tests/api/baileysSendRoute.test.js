'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app } from '../../server.js';

const require = createRequire(import.meta.url);

describe('deliveryStore selection for local Baileys + Cashier sends', () => {
    const envBackup = {
        GATEWAY_IDEMPOTENCY_STORE: process.env.GATEWAY_IDEMPOTENCY_STORE,
        DB_SERVER: process.env.DB_SERVER,
        VITEST: process.env.VITEST,
    };

    afterEach(() => {
        for (const [key, value] of Object.entries(envBackup)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        vi.resetModules();
    });

    it('uses memory when DB_SERVER is a placeholder (avoids false whatsapp_not_ready)', () => {
        process.env.GATEWAY_IDEMPOTENCY_STORE = '';
        process.env.DB_SERVER = 'YOUR_PC_NAME_OR_IP';
        delete process.env.VITEST;
        vi.resetModules();
        const { shouldUseMemoryStore, isDatabaseConfigured } = require('../../services/idempotency/deliveryStore');
        expect(isDatabaseConfigured()).toBe(false);
        expect(shouldUseMemoryStore()).toBe(true);
    });

    it('uses sql only when explicitly requested or real DB_SERVER is set', () => {
        process.env.GATEWAY_IDEMPOTENCY_STORE = 'sql';
        process.env.DB_SERVER = 'YOUR_PC_NAME_OR_IP';
        delete process.env.VITEST;
        vi.resetModules();
        let mod = require('../../services/idempotency/deliveryStore');
        expect(mod.shouldUseMemoryStore()).toBe(false);

        process.env.GATEWAY_IDEMPOTENCY_STORE = '';
        process.env.DB_SERVER = 'real-sql-host.local';
        delete process.env.VITEST;
        vi.resetModules();
        mod = require('../../services/idempotency/deliveryStore');
        expect(mod.isDatabaseConfigured()).toBe(true);
        expect(mod.shouldUseMemoryStore()).toBe(false);
    });
});

describe('POST /api/whatsapp/send transport readiness (Baileys path)', () => {
    const requireSvc = createRequire(import.meta.url);
    let whatsappService;
    let useMemoryDeliveryStore;

    beforeEach(() => {
        vi.resetModules();
        whatsappService = requireSvc('../../services/whatsappService');
        useMemoryDeliveryStore = requireSvc('../../services/idempotency/deliveryStore').useMemoryDeliveryStore;
        useMemoryDeliveryStore();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('idempotent send succeeds when Baileys isReady=true (Selenium irrelevant)', async () => {
        vi.spyOn(whatsappService, 'isReady').mockResolvedValue(true);
        vi.spyOn(whatsappService, 'getOrCreateDriver').mockResolvedValue(null);
        vi.spyOn(whatsappService, 'isDebugPortActive').mockResolvedValue(false);
        const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait').mockResolvedValue({
            success: true,
            status: 'sent',
            messageId: 'wa-baileys-idemp-ok',
            phone: '201111962602',
        });

        const res = await request(app)
            .post('/api/whatsapp/send')
            .send({
                phone: '201111962602',
                message: 'BAILEYS-SEND-ROUTE-TEST',
                idempotencyKey: `baileys-route-test-${Date.now()}`,
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.messageId).toBe('wa-baileys-idemp-ok');
        expect(sendMessageAndWait).toHaveBeenCalledTimes(1);
        expect(whatsappService.isReady).toHaveBeenCalled();
    });

    it('idempotent send returns 503 when transport isReady=false', async () => {
        vi.spyOn(whatsappService, 'isReady').mockResolvedValue(false);
        vi.spyOn(whatsappService, 'getOrCreateDriver').mockResolvedValue(null);
        const sendMessageAndWait = vi.spyOn(whatsappService, 'sendMessageAndWait');

        const res = await request(app)
            .post('/api/whatsapp/send')
            .send({
                phone: '201111962602',
                message: 'BAILEYS-SEND-ROUTE-NOT-READY',
                idempotencyKey: `baileys-not-ready-${Date.now()}`,
            });

        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(String(res.body.error || '')).toMatch(/not ready/i);
        expect(sendMessageAndWait).not.toHaveBeenCalled();
    });
});
