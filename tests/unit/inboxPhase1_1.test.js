import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
const {
  resolveProviderMessageId,
  buildFingerprint,
  ID_SOURCE,
  extractMessageTimestamp,
} = require('../../services/inbox/normalizeMessage');
const { createInboxSpool } = require('../../services/inbox/inboxSpool');
const { createSendQueue } = require('../../services/sendQueue');

describe('Phase 1.1 hardening', () => {
  describe('fallback ProviderMessageID', () => {
    it('uses fingerprint_stable when timestamp or waMessageKey exists', () => {
      const result = resolveProviderMessageId({
        id: '',
        text: 'تمام',
        prePlainText: '[10:30 AM, 8/28/2026] Ahmed: تمام',
      }, 'Ahmed');
      expect(result.idSource).toBe(ID_SOURCE.FINGERPRINT_STABLE);
      expect(result.providerMessageId.startsWith('fp-')).toBe(true);
    });

    it('uses fingerprint_degraded only when no stable discriminator exists', () => {
      const result = resolveProviderMessageId({
        id: '',
        text: 'تمام',
        domIndex: 3,
      }, 'Ahmed');
      expect(result.idSource).toBe(ID_SOURCE.FINGERPRINT_DEGRADED);
    });

    it('reprocessing the same raw message yields the same fingerprint ID', () => {
      const raw = {
        id: '',
        text: 'hello',
        prePlainText: '[10:31 AM, 8/28/2026] Ahmed: hello',
      };
      const first = resolveProviderMessageId(raw, 'Ahmed');
      const second = resolveProviderMessageId(raw, 'Ahmed');
      expect(first).toEqual(second);
    });

    it('same text with different timestamps yields different stable IDs', () => {
      const a = buildFingerprint({
        text: 'تمام',
        prePlainText: '[10:30 AM, 8/28/2026] Ahmed: تمام',
      }, 'Ahmed');
      const b = buildFingerprint({
        text: 'تمام',
        prePlainText: '[10:31 AM, 8/28/2026] Ahmed: تمام',
      }, 'Ahmed');
      expect(a.providerMessageId).not.toBe(b.providerMessageId);
      expect(a.idSource).toBe(ID_SOURCE.FINGERPRINT_STABLE);
      expect(b.idSource).toBe(ID_SOURCE.FINGERPRINT_STABLE);
    });

    it('domIndex changes do not alter fingerprint_stable IDs', () => {
      const a = buildFingerprint({
        text: 'hello',
        prePlainText: '[10:30 AM, 8/28/2026] Ahmed: hello',
        domIndex: 1,
      }, 'Ahmed');
      const b = buildFingerprint({
        text: 'hello',
        prePlainText: '[10:30 AM, 8/28/2026] Ahmed: hello',
        domIndex: 99,
      }, 'Ahmed');
      expect(a.idSource).toBe(ID_SOURCE.FINGERPRINT_STABLE);
      expect(a.providerMessageId).toBe(b.providerMessageId);
    });

    it('extracts message timestamp from prePlainText brackets', () => {
      expect(extractMessageTimestamp('[9:41 AM, 3/25/2024] Name: hi')).toBe('9:41 AM, 3/25/2024');
    });
  });

  describe('spool cleanup', () => {
    it('never purges pending messages while pruning old delivered rows', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-spool-clean-'));
      const spoolFile = path.join(tempDir, 'spool.json');
      const spool = createInboxSpool({
        spoolFile,
        // force small retention via env override in test by direct cleanup call
      });

      spool.capture({
        provider: 'whatsapp-web',
        providerMessageId: 'pending-1',
        idSource: 'native',
        text: 'pending',
        chatTitle: 'A',
        messageType: 'text',
        isGroup: false,
        receivedAt: new Date().toISOString(),
        rawPayload: {},
      });

      const delivered = spool.capture({
        provider: 'whatsapp-web',
        providerMessageId: 'delivered-old',
        idSource: 'native',
        text: 'old',
        chatTitle: 'A',
        messageType: 'text',
        isGroup: false,
        receivedAt: new Date().toISOString(),
        rawPayload: {},
      });
      spool.markDelivered('delivered-old');
      delivered.deliveredAt = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString();
      spool.persist();

      spool.cleanupDelivered();
      expect(spool.hasProviderMessageId('pending-1')).toBe(true);
      expect(spool.hasProviderMessageId('delivered-old')).toBe(false);
    });
  });

  describe('sendQueue timing visibility', () => {
    it('reports browserQueueWaitMs and browserOperationMs', async () => {
      const queue = createSendQueue();
      await queue.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'ok';
      });
      const timing = queue.getTimingStats();
      expect(timing.browserOperationMs).toBeGreaterThanOrEqual(15);
      expect(typeof timing.browserQueueWaitMs).toBe('number');
    });
  });
});
