import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  resolveMessageDirection,
  isPresenceOrStatusText,
  pickContactTitle,
  isFromMeMessage,
} = require('../../services/inbox/inboxLogic');
const {
  normalizeMessage,
  validateNormalizedEvent,
  resolveProviderMessageId,
} = require('../../services/inbox/normalizeMessage');
const { selectIncomingMessages } = require('../../services/inbox/whatsappInboxAdapter');

describe('inbound capture fixes', () => {
  describe('direction detection', () => {
    it('true_ data-id is outbound (fromMe)', () => {
      expect(resolveMessageDirection({ id: 'true_201012126899@c.us_3EB0ABC' })).toBe('outbound');
      expect(isFromMeMessage({ id: 'true_201012126899@c.us_3EB0ABC' })).toBe(true);
    });

    it('false_ data-id is inbound', () => {
      expect(resolveMessageDirection({ id: 'false_201012126899@c.us_3EB0ABC' })).toBe('inbound');
      expect(isFromMeMessage({ id: 'false_201012126899@c.us_3EB0ABC' })).toBe(false);
    });

    it('ignores own outbound invoice message', () => {
      const outbound = {
        id: 'true_201012126899@c.us_INVOICE1',
        text: 'تم تسجيل فاتورة جديدة لك كريم',
        className: 'message-out',
      };
      expect(normalizeMessage(outbound, 'Karim')).toBeNull();
      expect(resolveProviderMessageId(outbound, 'Karim')).toBeNull();
    });

    it('captures incoming customer message', () => {
      const event = normalizeMessage({
        id: 'false_201012126899@c.us_AAA111',
        text: 'مساء الخير',
        className: 'message-in',
      }, 'Karim');

      expect(event).toMatchObject({
        direction: 'inbound',
        text: 'مساء الخير',
        phone: '201012126899',
        remoteJid: '201012126899@c.us',
        chatTitle: 'Karim',
      });
    });

    it('selectIncomingMessages keeps only inbound and limits to unread count', () => {
      const selected = selectIncomingMessages([
        { id: 'false_20100@c.us_1', text: 'old', className: 'message-in' },
        { id: 'true_20100@c.us_2', text: 'invoice', className: 'message-out' },
        { id: 'false_20100@c.us_3', text: 'مساء الخير', className: 'message-in' },
      ], 1);
      expect(selected.map((m) => m.text)).toEqual(['مساء الخير']);
    });
  });

  describe('chat identity extraction', () => {
    it('rejects presence/last-seen header text', () => {
      expect(isPresenceOrStatusText('آخر ظهور اليوم عند 15:40')).toBe(true);
      expect(isPresenceOrStatusText('last seen today at 15:40')).toBe(true);
      expect(isPresenceOrStatusText('Karim Saad')).toBe(false);
    });

    it('prefers sidebar contact title over presence header', () => {
      expect(pickContactTitle('Karim Saad', 'آخر ظهور اليوم عند 15:40')).toBe('Karim Saad');
    });

    it('uses remoteJid phone when chat title is presence text', () => {
      const event = normalizeMessage({
        id: 'false_201012126899@c.us_BBB222',
        text: 'مساء الخير',
        className: 'message-in',
      }, 'آخر ظهور اليوم عند 15:40', {
        remoteJid: '201012126899@c.us',
      });

      expect(event).toMatchObject({
        phone: '201012126899',
        chatTitle: '201012126899',
        direction: 'inbound',
      });
    });
  });

  describe('webhook payload validation', () => {
    it('validates required Cashier fields', () => {
      const valid = validateNormalizedEvent({
        provider: 'whatsapp-web',
        providerMessageId: 'false_20100@c.us_AAA',
        direction: 'inbound',
        phone: '201012126899',
        chatTitle: 'Karim',
        messageType: 'text',
        receivedAt: new Date().toISOString(),
        isGroup: false,
      });
      expect(valid.valid).toBe(true);

      const invalid = validateNormalizedEvent({
        provider: 'whatsapp-web',
        providerMessageId: 'fp-abc',
        direction: 'inbound',
        phone: null,
        chatTitle: 'آخر ظهور اليوم عند 15:40',
        messageType: 'text',
        receivedAt: new Date().toISOString(),
        isGroup: false,
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors).toContain('MISSING_PHONE');
      expect(invalid.errors).toContain('INVALID_CHAT_TITLE');
    });

    it('does not collapse identical text with different native IDs', () => {
      const a = normalizeMessage({
        id: 'false_20100@c.us_AAA',
        text: 'تمام',
        prePlainText: '[10:30 AM, 8/28/2026] Karim: تمام',
      }, 'Karim');
      const b = normalizeMessage({
        id: 'false_20100@c.us_BBB',
        text: 'تمام',
        prePlainText: '[10:31 AM, 8/28/2026] Karim: تمام',
      }, 'Karim');
      expect(a.providerMessageId).not.toBe(b.providerMessageId);
    });
  });
});
