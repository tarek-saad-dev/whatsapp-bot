import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMirrorChat, normalizeMirrorMessage } from '../src/mirrorSync.js';

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
