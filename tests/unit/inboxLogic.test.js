import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  arabicIndicToAscii,
  isUnreadLabel,
  parseUnreadCount,
  summarizeUnreadChats,
  parseRemoteFromDataId,
  isFromMeMessage,
  normalizeIncomingMessage,
  ingestChatMessages,
  ingestPreviewEvents,
  createInboxStore,
} = require('../../services/inbox/inboxLogic');

describe('inboxLogic', () => {
  it('parses English and Arabic unread labels', () => {
    expect(isUnreadLabel('1 unread message')).toBe(true);
    expect(isUnreadLabel('3 unread messages')).toBe(true);
    expect(isUnreadLabel('رسالة غير مقروءة')).toBe(true);
    expect(isUnreadLabel('٢ رسائل غير مقروءة')).toBe(true);
    expect(isUnreadLabel('Last seen today')).toBe(false);
    expect(parseUnreadCount(['1 unread message'])).toBe(1);
    expect(parseUnreadCount(['3 unread messages'])).toBe(3);
    expect(parseUnreadCount(['٢ رسائل غير مقروءة'])).toBe(2);
    expect(parseUnreadCount(['رسالة غير مقروءة'])).toBe(1);
    expect(parseUnreadCount(['chat header'])).toBe(0);
  });

  it('converts Arabic-Indic digits', () => {
    expect(arabicIndicToAscii('٣')).toBe('3');
  });

  it('summarizes unread chats and dedupes titles', () => {
    const chats = summarizeUnreadChats([
      { title: 'Ahmed', ariaLabels: ['1 unread message'] },
      { title: 'Ahmed', ariaLabels: ['1 unread message'] },
      { title: 'Sales', ariaLabels: ['chat'] },
      { title: 'Team', ariaLabels: ['٢ رسائل غير مقروءة'] },
    ]);
    expect(chats).toEqual([
      { title: 'Ahmed', unreadCount: 1 },
      { title: 'Team', unreadCount: 2 },
    ]);
  });

  it('parses remote chat ids from WhatsApp data-id', () => {
    expect(parseRemoteFromDataId('false_201557994946@c.us_3EB0ABC')).toBe('201557994946@c.us');
    expect(parseRemoteFromDataId('true_1203630@g.us_3EB0XYZ')).toBe('1203630@g.us');
  });

  it('detects outgoing vs incoming messages', () => {
    expect(isFromMeMessage({ id: 'true_20100@c.us_1' })).toBe(true);
    expect(isFromMeMessage({ id: 'false_20100@c.us_1' })).toBe(false);
    expect(isFromMeMessage({ id: 'x', className: 'message-out' })).toBe(true);
    expect(isFromMeMessage({ id: 'x', className: 'message-in' })).toBe(false);
  });

  it('normalizes incoming messages and skips outgoing', () => {
    expect(normalizeIncomingMessage({ id: 'true_20100@c.us_1', text: 'hi' }, 'Me')).toBeNull();
    const incoming = normalizeIncomingMessage(
      { id: 'false_201557994946@c.us_3EB0ABC', text: 'السلام عليكم' },
      'Ahmed',
    );
    expect(incoming).toMatchObject({
      messageId: 'false_201557994946@c.us_3EB0ABC',
      chatTitle: 'Ahmed',
      chatId: '201557994946@c.us',
      phone: '201557994946',
      isGroup: false,
      text: 'السلام عليكم',
    });
  });

  it('on first sight of a chat reports only unread incoming messages', () => {
    const seenIds = new Set();
    const seededChats = new Set();
    const fresh = ingestChatMessages({
      chatTitle: 'Ahmed',
      unreadCount: 1,
      seenIds,
      seededChats,
      messages: [
        { id: 'false_20100@c.us_old', text: 'old' },
        { id: 'true_20100@c.us_mine', text: 'mine' },
        { id: 'false_20100@c.us_new', text: 'new' },
      ],
    });
    expect(fresh.map((m) => m.text)).toEqual(['new']);
    expect(seenIds.size).toBe(2);
  });

  it('on later polls reports only unseen incoming messages', () => {
    const store = createInboxStore();
    store.ingest({
      chatTitle: 'Ahmed',
      unreadCount: 0,
      messages: [{ id: 'false_20100@c.us_1', text: 'seed' }],
    });
    const next = store.ingest({
      chatTitle: 'Ahmed',
      unreadCount: 0,
      messages: [
        { id: 'false_20100@c.us_1', text: 'seed' },
        { id: 'false_20100@c.us_2', text: 'hello' },
      ],
    });
    expect(next.map((m) => m.text)).toEqual(['hello']);
    expect(store.list(10)).toHaveLength(1);
  });

  it('normalizes preview trigger events from chat list', () => {
    const seenIds = new Set();
    const recentByChat = new Map();
    const fresh = ingestPreviewEvents([{
      chatTitle: '201557994946',
      previewText: 'مرحبا',
      unreadCount: 2,
      triggeredAt: '2026-08-28T07:00:00.000Z',
    }], seenIds, recentByChat);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].phone).toBe('201557994946');
    expect(fresh[0].text).toBe('مرحبا');
    expect(fresh[0].source).toBe('chat_list_trigger');
  });

  it('filters typing previews and dedupes rapid repeats', () => {
    const { isTypingPreview, ingestPreviewEvents } = require('../../services/inbox/inboxLogic');
    expect(isTypingPreview('يكتب...')).toBe(true);
    expect(isTypingPreview('typing...')).toBe(true);
    expect(isTypingPreview('السلام')).toBe(false);

    const seenIds = new Set();
    const recentByChat = new Map();
    const events = [
      { chatTitle: 'Ahmed', previewText: 'يكتب...', unreadCount: 1, triggeredAt: '2026-08-28T07:00:01.000Z' },
      { chatTitle: 'Ahmed', previewText: 'مرحبا', unreadCount: 1, triggeredAt: '2026-08-28T07:00:02.000Z' },
      { chatTitle: 'Ahmed', previewText: 'مرحبا', unreadCount: 1, triggeredAt: '2026-08-28T07:00:03.000Z' },
    ];
    const fresh = ingestPreviewEvents(events, seenIds, recentByChat);
    expect(fresh.map((m) => m.text)).toEqual(['مرحبا']);
  });
});
