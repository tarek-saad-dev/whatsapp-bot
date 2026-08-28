import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
const { normalizeMessage, resolveProviderMessageId } = require('../../services/inbox/normalizeMessage');
const { createInboxSpool } = require('../../services/inbox/inboxSpool');
const {
  createInboxDeliveryWorker,
  DEFAULT_BACKOFF_MS,
} = require('../../services/inbox/inboxDeliveryWorker');
const { createInboxListener } = require('../../services/inbox/inboxListener');

describe('Phase 1 inbox pipeline', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-inbox-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('A. normalization', () => {
    it('produces the canonical normalized event', () => {
      const event = normalizeMessage({
        id: 'false_201557994946@c.us_3EB0ABC',
        text: 'عايز احجز بكرة',
        className: 'message-in',
      }, 'Ahmed');

      expect(event).toMatchObject({
        provider: 'whatsapp-web',
        providerMessageId: 'false_201557994946@c.us_3EB0ABC',
        idSource: 'native',
        direction: 'inbound',
        phone: '201557994946',
        remoteJid: '201557994946@c.us',
        chatTitle: 'Ahmed',
        messageType: 'text',
        text: 'عايز احجز بكرة',
        isGroup: false,
      });
      expect(event.rawPayload.dataId).toBe('false_201557994946@c.us_3EB0ABC');
    });
  });

  describe('B. stable ID', () => {
    it('returns the same providerMessageId for the same native raw message', () => {
      const raw = {
        id: 'false_201557994946@c.us_3EB0ABC',
        text: 'تمام',
      };
      const first = resolveProviderMessageId(raw, 'Ahmed');
      const second = resolveProviderMessageId(raw, 'Ahmed');
      expect(first).toEqual(second);
      expect(first.idSource).toBe('native');
    });
  });

  describe('C. different messages', () => {
    it('does not collapse two events with same text but different native IDs', () => {
      const a = normalizeMessage({ id: 'false_20100@c.us_AAA', text: 'تمام' }, 'Ahmed');
      const b = normalizeMessage({ id: 'false_20100@c.us_BBB', text: 'تمام' }, 'Ahmed');
      expect(a.providerMessageId).not.toBe(b.providerMessageId);
    });
  });

  describe('D. durable pending queue', () => {
    it('keeps pending events after reload', () => {
      const spoolFile = path.join(tempDir, 'spool.json');
      const spool = createInboxSpool({ spoolFile });
      spool.capture(normalizeMessage({
        id: 'false_201557994946@c.us_3EB0ABC',
        text: 'phase1-smoke',
      }, 'Ahmed'));

      const reloaded = createInboxSpool({ spoolFile });
      expect(reloaded.getStats().pending).toBe(1);
      expect(reloaded.hasProviderMessageId('false_201557994946@c.us_3EB0ABC')).toBe(true);
    });
  });

  describe('E/F/G. delivery worker', () => {
    it('marks delivered on ERP 201 success', async () => {
      const spool = createInboxSpool({ spoolFile: path.join(tempDir, 'spool-a.json') });
      const event = normalizeMessage({ id: 'false_20100@c.us_AAA', text: 'hello' }, 'Ahmed');
      spool.capture(event);

      const fetchImpl = vi.fn().mockResolvedValue({
        status: 201,
        json: async () => ({ ok: true, duplicate: false }),
      });
      const worker = createInboxDeliveryWorker({
        spool,
        webhookUrl: 'http://cashier.test/inbox',
        fetchImpl,
      });

      await worker.processRecord(spool.getPendingForDelivery()[0]);
      expect(spool.getStats().delivered).toBe(1);
    });

    it('marks delivered on ERP duplicate=true', async () => {
      const spool = createInboxSpool({ spoolFile: path.join(tempDir, 'spool-b.json') });
      spool.capture(normalizeMessage({ id: 'false_20100@c.us_BBB', text: 'hello' }, 'Ahmed'));

      const fetchImpl = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ ok: true, duplicate: true }),
      });
      const worker = createInboxDeliveryWorker({ spool, webhookUrl: 'http://cashier.test/inbox', fetchImpl });
      await worker.processRecord(spool.getPendingForDelivery()[0]);
      expect(spool.getStats().delivered).toBe(1);
    });

    it('marks invalid pending events as quarantined without calling webhook', async () => {
      const spool = createInboxSpool({ spoolFile: path.join(tempDir, 'spool-q.json') });
      spool.capture({
        provider: 'whatsapp-web',
        providerMessageId: 'bad-event-1',
        idSource: 'fingerprint_degraded',
        direction: 'inbound',
        phone: null,
        chatTitle: 'آخر ظهور اليوم عند 15:40',
        messageType: 'text',
        text: 'bad',
        isGroup: false,
        receivedAt: new Date().toISOString(),
        rawPayload: {},
      });

      const fetchImpl = vi.fn();
      const worker = createInboxDeliveryWorker({
        spool,
        webhookUrl: 'http://cashier.test/inbox',
        fetchImpl,
      });

      await worker.processRecord(spool.getPendingForDelivery()[0]);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(spool.getStats().failedOrRetrying).toBe(1);
      expect(spool.getStats().pending).toBe(0);
    });

    it('logs Cashier 400 code and message on permanent delivery error', async () => {
      const spool = createInboxSpool({ spoolFile: path.join(tempDir, 'spool-d.json') });
      spool.capture(normalizeMessage({ id: 'false_20100@c.us_DDD', text: 'hello' }, 'Ahmed'));

      const fetchImpl = vi.fn().mockResolvedValue({
        status: 400,
        json: async () => ({ ok: false, code: 'MISSING_PHONE', error: 'phone is required' }),
      });
      const worker = createInboxDeliveryWorker({
        spool,
        webhookUrl: 'http://cashier.test/inbox',
        fetchImpl,
      });

      await worker.processRecord(spool.getPendingForDelivery()[0]);
      expect(spool.getStats().failedOrRetrying).toBe(1);
    });

    it('keeps pending and schedules retry on network failure', async () => {
      const spool = createInboxSpool({ spoolFile: path.join(tempDir, 'spool-c.json') });
      spool.capture(normalizeMessage({ id: 'false_20100@c.us_CCC', text: 'hello' }, 'Ahmed'));

      const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const worker = createInboxDeliveryWorker({ spool, webhookUrl: 'http://cashier.test/inbox', fetchImpl });
      const record = spool.getPendingForDelivery()[0];
      await worker.processRecord(record);

      expect(spool.getStats().pending).toBe(1);
      expect(spool.getPendingForDelivery()).toHaveLength(0);
      expect(spool.getStats().pending).toBe(1);
    });
  });

  describe('listener uses sendQueue for adapter poll', () => {
    it('captures through adapter and persists before delivery', async () => {
      const spoolFile = path.join(tempDir, 'listener-spool.json');
      const spool = createInboxSpool({ spoolFile });
      const enqueue = vi.fn(async (task) => task());
      const sendQueue = {
        enqueue,
        getStats: () => ({ active: 0, queued: 0 }),
        getTimingStats: () => ({ browserQueueWaitMs: 5, browserOperationMs: 120 }),
      };

      const rowClick = vi.fn().mockResolvedValue(undefined);
      const driver = {
        executeScript: vi.fn()
          .mockResolvedValueOnce({ installed: true, trackedChats: 2 })
          .mockResolvedValueOnce({ installed: true, queued: 0 })
          .mockResolvedValueOnce({ events: [], status: { installed: true, queued: 0 } })
          .mockResolvedValueOnce({ events: [], status: { installed: true, queued: 0 } })
          .mockResolvedValueOnce([{ title: 'Ahmed', ariaLabels: ['1 unread message'] }])
          .mockResolvedValueOnce({
            chatTitle: 'Ahmed',
            remoteJid: '201557994946@c.us',
            messages: [{ id: 'false_201557994946@c.us_NEW', text: 'phase1', className: 'message-in' }],
          }),
        findElement: vi.fn().mockResolvedValue({ click: rowClick }),
      };

      const listener = createInboxListener({
        getDriver: () => driver,
        isReady: async () => true,
        switchToWhatsAppTab: async () => true,
        sendQueue,
        spool,
        deliveryWorker: { start: vi.fn(), stop: vi.fn(), tick: vi.fn(), getStatus: () => ({ running: false }) },
      });

      const captured = await listener.pollOnce();
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(1);
      expect(spool.getStats().pending).toBe(1);
      expect(rowClick).toHaveBeenCalledTimes(1);
    });
  });
});
