import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeRequestHash } = require('../../services/idempotency/requestHash');
const { claimDelivery, recordSendOutcome } = require('../../services/idempotency/claimDelivery');
const { createMemoryDeliveryStore } = require('../../services/idempotency/memoryDeliveryStore');
const { STATUSES, CODES } = require('../../services/idempotency/constants');

const PHONE = '201557994946';
const MESSAGE = 'hello';
const KEY = 'sale:1:40004:customer_receipt';

describe('request hash', () => {
  it('is SHA-256 hex of normalized phone + trimmed message', () => {
    const hash = computeRequestHash(PHONE, MESSAGE);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(computeRequestHash(PHONE, MESSAGE));
  });

  it('does not change when metadata would have differed', () => {
    const a = computeRequestHash(PHONE, MESSAGE);
    const b = computeRequestHash(PHONE, MESSAGE);
    expect(a).toBe(b);
    expect(computeRequestHash(PHONE, `${MESSAGE}!`)).not.toBe(a);
    expect(computeRequestHash('201039244023', MESSAGE)).not.toBe(a);
  });
});

describe('claimDelivery', () => {
  let store;

  beforeEach(() => {
    store = createMemoryDeliveryStore();
  });

  it('first claim owns the send', async () => {
    const claim = await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
    expect(claim.action).toBe('send');
    expect(claim.retry).toBe(false);
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.PROCESSING);
    expect(row.attemptCount).toBe(1);
  });

  it('duplicate claim with same hash while processing is in_progress', async () => {
    await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
    const second = await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
    expect(second.action).toBe('in_progress');
    expect(second.code).toBe(CODES.IDEMPOTENCY_IN_PROGRESS);
  });

  it('same key + different payload is conflict', async () => {
    await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
    const second = await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: 'other',
      store,
    });
    expect(second.action).toBe('conflict');
    expect(second.code).toBe(CODES.IDEMPOTENCY_CONFLICT);
  });

  it('sent row replays without a new claim', async () => {
    await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
    await recordSendOutcome({
      idempotencyKey: KEY,
      sendResult: { success: true, messageId: 'wa-1' },
      store,
    });
    const replay = await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
    expect(replay.action).toBe('replay');
    expect(replay.row.providerMessageId).toBe('wa-1');
  });

  it('stale processing becomes unknown and is not claimed for send', async () => {
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    store.seed({
      idempotencyKey: KEY,
      requestHash: computeRequestHash(PHONE, MESSAGE),
      phone: PHONE,
      status: STATUSES.PROCESSING,
      attemptCount: 1,
      createdAt: stale,
      updatedAt: stale,
    });
    const claim = await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
    expect(claim.action).toBe('unknown');
    expect(claim.reason).toBe('stale_processing');
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.UNKNOWN);
  });

  it('unknown is not retried', async () => {
    store.seed({
      idempotencyKey: KEY,
      requestHash: computeRequestHash(PHONE, MESSAGE),
      phone: PHONE,
      status: STATUSES.UNKNOWN,
      attemptCount: 1,
      createdAt: new Date(),
    });
    const claim = await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
    expect(claim.action).toBe('unknown');
    expect(claim.code).toBe(CODES.DELIVERY_STATUS_UNKNOWN);
  });

  it('retryable_failed can be claimed again and increments AttemptCount', async () => {
    store.seed({
      idempotencyKey: KEY,
      requestHash: computeRequestHash(PHONE, MESSAGE),
      phone: PHONE,
      status: STATUSES.RETRYABLE_FAILED,
      attemptCount: 1,
      createdAt: new Date(),
    });
    const claim = await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
    expect(claim.action).toBe('send');
    expect(claim.retry).toBe(true);
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.PROCESSING);
    expect(row.attemptCount).toBe(2);
  });

  it('concurrent first inserts yield a single owner', async () => {
    const [a, b] = await Promise.all([
      claimDelivery({
        idempotencyKey: KEY,
        normalizedPhone: PHONE,
        trimmedMessage: MESSAGE,
        store,
      }),
      claimDelivery({
        idempotencyKey: KEY,
        normalizedPhone: PHONE,
        trimmedMessage: MESSAGE,
        store,
      }),
    ]);
    const actions = [a.action, b.action].sort();
    expect(actions).toEqual(['in_progress', 'send']);
    const row = await store.getByKey(KEY);
    expect(row.attemptCount).toBe(1);
  });
});

describe('recordSendOutcome', () => {
  let store;

  beforeEach(async () => {
    store = createMemoryDeliveryStore();
    await claimDelivery({
      idempotencyKey: KEY,
      normalizedPhone: PHONE,
      trimmedMessage: MESSAGE,
      store,
    });
  });

  it('stores sent + messageId on success', async () => {
    const recorded = await recordSendOutcome({
      idempotencyKey: KEY,
      sendResult: { success: true, messageId: 'wa-99' },
      store,
    });
    expect(recorded.ledgerStatus).toBe(STATUSES.SENT);
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.SENT);
    expect(row.providerMessageId).toBe('wa-99');
    expect(row.sentAt).toBeTruthy();
    expect(row.lastError).toBeNull();
  });

  it('pre-send failure is retryable_failed', async () => {
    await recordSendOutcome({
      idempotencyKey: KEY,
      sendResult: { error: 'not ready' },
      preSendFailure: true,
      store,
    });
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.RETRYABLE_FAILED);
  });

  it('ambiguous send failure is unknown', async () => {
    await recordSendOutcome({
      idempotencyKey: KEY,
      sendResult: { success: false, error: 'chrome crashed after compose' },
      preSendFailure: false,
      store,
    });
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.UNKNOWN);
  });

  it('success without messageId is unknown', async () => {
    await recordSendOutcome({
      idempotencyKey: KEY,
      sendResult: { success: true, status: 'sent' },
      store,
    });
    const row = await store.getByKey(KEY);
    expect(row.status).toBe(STATUSES.UNKNOWN);
    expect(row.lastError).toBe('missing_message_id');
  });
});

describe('gateway delivery migration SQL', () => {
  it('creates a gateway-only ledger with unique key and known statuses', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const sql = readFileSync(
      path.join(process.cwd(), 'sql/create-tbl-whatsapp-gateway-delivery.sql'),
      'utf8',
    );
    expect(sql).toContain('TblWhatsAppGatewayDelivery');
    expect(sql).toContain('UQ_TblWhatsAppGatewayDelivery_IdempotencyKey');
    expect(sql).toContain("N'processing'");
    expect(sql).toContain("N'sent'");
    expect(sql).toContain("N'retryable_failed'");
    expect(sql).toContain("N'unknown'");
    expect(sql).toContain('[AttemptCount] >= 0');
    expect(sql).not.toContain('TblMessageOutbox');
    expect(sql).not.toContain('TblMessageTemplate');
  });
});
