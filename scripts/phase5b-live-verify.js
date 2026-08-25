#!/usr/bin/env node
'use strict';

/**
 * Phase 5B live verification:
 * POST the same generic message twice with a fixed idempotency key.
 * Requires a running local WhatsApp gateway and a configured test phone.
 *
 * Does not read customer numbers from the database.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getPool, closeConnection } = require('../services/database');

const KEY = 'gateway:phase5b:e2e';
const MESSAGE = '[ERP-GATEWAY-IDEMPOTENCY-5B]';

function resolvePhone() {
    const raw = process.env.WHATSAPP_E2E_TEST_PHONE || process.env.TEST_WHATSAPP_NUMBER || '';
    return String(raw).trim();
}

async function postSend(baseUrl, body) {
    const res = await fetch(`${baseUrl}/api/whatsapp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, body: json };
}

async function deleteLedgerRow(key) {
    const pool = await getPool();
    const result = await pool.request()
        .input('key', key)
        .query(`
            DELETE FROM dbo.TblWhatsAppGatewayDelivery
            WHERE IdempotencyKey = @key
        `);
    return result.rowsAffected[0] || 0;
}

async function main() {
    const phone = resolvePhone();
    if (!phone) {
        throw new Error('Set WHATSAPP_E2E_TEST_PHONE (or TEST_WHATSAPP_NUMBER) to a dedicated test number.');
    }

    const port = Number(process.env.PORT || 3000);
    const baseUrl = process.env.WHATSAPP_GATEWAY_URL || `http://127.0.0.1:${port}`;

    const health = await fetch(`${baseUrl}/api/health`);
    if (!health.ok) {
        throw new Error(`Gateway health check failed at ${baseUrl}/api/health`);
    }

    const payload = {
        phone,
        message: MESSAGE,
        idempotencyKey: KEY,
        metadata: { source: 'phase5b-e2e' },
    };

    console.log(`First send → ${baseUrl}/api/whatsapp/send key=${KEY}`);
    const firstStarted = Date.now();
    const first = await postSend(baseUrl, payload);
    const firstMs = Date.now() - firstStarted;
    console.log('first', first.status, first.body, `elapsedMs=${firstMs}`);

    if (!first.body.success || first.body.status !== 'sent' || !first.body.messageId) {
        throw new Error('First send did not succeed with a messageId');
    }
    if (first.body.idempotentReplay === true) {
        throw new Error('First send unexpectedly reported idempotentReplay=true');
    }

    console.log('Second send (replay) with the same phone/message/key');
    const secondStarted = Date.now();
    const second = await postSend(baseUrl, payload);
    const secondMs = Date.now() - secondStarted;
    console.log('second', second.status, second.body, `elapsedMs=${secondMs}`);

    if (!second.body.success || second.body.status !== 'sent') {
        throw new Error('Replay did not return success/sent');
    }
    if (second.body.idempotentReplay !== true) {
        throw new Error('Replay missing idempotentReplay=true');
    }
    if (second.body.messageId !== first.body.messageId) {
        throw new Error(`Replay messageId mismatch: ${second.body.messageId} vs ${first.body.messageId}`);
    }

    const pool = await getPool();
    const ledger = await pool.request()
        .input('key', KEY)
        .query(`
            SELECT IdempotencyKey, Status, ProviderMessageID, AttemptCount, Phone
            FROM dbo.TblWhatsAppGatewayDelivery
            WHERE IdempotencyKey = @key
        `);
    console.table(ledger.recordset);
    if (ledger.recordset.length !== 1) {
        throw new Error(`Expected one ledger row, found ${ledger.recordset.length}`);
    }
    if (Number(ledger.recordset[0].AttemptCount) !== 1) {
        throw new Error(`Expected AttemptCount=1 after replay, got ${ledger.recordset[0].AttemptCount}`);
    }

    const deleted = await deleteLedgerRow(KEY);
    console.log(`Deleted test ledger rows: ${deleted}`);
    await closeConnection();

    console.log(JSON.stringify({
        ok: true,
        firstElapsedMs: firstMs,
        replayElapsedMs: secondMs,
        attemptCount: Number(ledger.recordset[0].AttemptCount),
        replayMessageId: second.body.messageId,
        idempotentReplay: second.body.idempotentReplay,
    }, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
