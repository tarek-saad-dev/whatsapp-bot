import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMirrorChat, normalizeMirrorMessage, confirmedCampaignMirror } from '../src/mirrorSync.js';

test('history mirror uses the SAME inbound provider ID as live ingest', async () => {
  const result = await normalizeMirrorMessage({
    key: { remoteJid: '201011747438@s.whatsapp.net', id: 'message-123', fromMe: false },
    message: { conversation: 'اهلا' },
    messageTimestamp: 1760000000,
  }, { historical: true });
  assert.equal(result.providerMessageId, 'false_201011747438@c.us_message-123');
  assert.equal(result.historical, true);
  assert.equal(result.direction, 'INBOUND');
  assert.equal(result.text, 'اهلا');
});

test('media metadata and quoted source survive mirror normalization', async () => {
  const result = await normalizeMirrorMessage({
    key: { remoteJid: '201011747438@s.whatsapp.net', id: 'photo-1', fromMe: false },
    message: { imageMessage: { caption: 'صورة', mimetype: 'image/jpeg', fileLength: 72,
      contextInfo: { stanzaId: 'parent-id' } } },
    messageTimestamp: 1760000000,
  }, { historical: false });
  assert.equal(result.contentType, 'IMAGE');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.fileSize, 72);
  assert.equal(result.quotedProviderMessageId, 'parent-id');
});

test('chat history can create contact without a message', async () => {
  const result = await normalizeMirrorChat({
    id: '201011747438@s.whatsapp.net', name: 'عميل جديد',
    conversationTimestamp: 1760000000, archived: true, pinned: 1,
  });
  assert.equal(result.kind, 'chat');
  assert.equal(result.displayName, 'عميل جديد');
  assert.equal(result.archived, true);
  assert.equal(result.pinned, true);
});

test('groups and status updates never become business customer conversations', async () => {
  const group = await normalizeMirrorMessage({
    key: { remoteJid: '123@g.us', id: 'group-id', fromMe: false },
    message: { conversation: 'some group text' },
  });
  const status = await normalizeMirrorChat({ id: 'status@broadcast' });
  assert.equal(group, null);
  assert.equal(status, null);
});


test('confirmed campaign creates the same mirror identity as a provider echo', async () => {
  const phone = '201011747438';
  const result = { key: { remoteJid: phone + '@s.whatsapp.net', id: 'actual-id', fromMe: true }, message: { conversation: 'campaign' }, messageTimestamp: 1760000000 };
  const args = { result, expectedId: 'actual-id', phone, text: 'campaign', idempotencyKey: 'campaign:11111111-1111-4111-8111-111111111111:' + phone, ownDigits: '201099999999', startedAt: 1760000000000 };
  const event = confirmedCampaignMirror(args);
  const echo = await normalizeMirrorMessage(result, { ownDigits: args.ownDigits });
  assert.equal(event.providerMessageId, echo.providerMessageId);
  assert.equal(event.contactKey, echo.contactKey);
  assert.equal(event.text, echo.text);
  assert.equal(event.historical, false);
  assert.equal(confirmedCampaignMirror({ ...args, expectedId: 'different' }), null);
  assert.equal(confirmedCampaignMirror({ ...args, idempotencyKey: 'manual:example' }), null);
  assert.equal(confirmedCampaignMirror({ ...args, result: { key: { ...result.key, fromMe: false } } }), null);
  assert.equal(confirmedCampaignMirror({ ...args, result: { key: { ...result.key, remoteJid: '201022222222@s.whatsapp.net' } } }), null);
  assert.equal(confirmedCampaignMirror({ ...args, ownDigits: phone }), null);
});

test('OTP echoes are redacted before journaling; inbound and ordinary outbound remain intact', async () => {
  const text = 'رمز التحقق الخاص بك في حسابك: *123456*\nصالح لمدة 5 دقائق. لا تشارك الرمز مع أي شخص.';
  const msg = { key: { remoteJid: '201011747438@s.whatsapp.net', id: 'otp', fromMe: true }, message: { conversation: text }, messageTimestamp: 1760000000 };
  const event = await normalizeMirrorMessage(msg, { ownDigits: '201099999999' });
  assert.ok(event.text.includes('تم إخفاء الرمز'));
  assert.ok(!event.text.includes('123456'));
  assert.equal((await normalizeMirrorMessage({ ...msg, key: { ...msg.key, fromMe: false } })).text, text);
  assert.equal((await normalizeMirrorMessage({ ...msg, message: { conversation: 'normal text' } })).text, 'normal text');
});
