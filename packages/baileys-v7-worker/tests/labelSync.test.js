import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLabelEdit, normalizeLabelAssociation } from '../src/labelSync.js';

test('label metadata mirrors name color and deletion', () => {
  assert.deepEqual(normalizeLabelEdit({ id: '3', name: ' Coach ', color: 4 }), {
    kind: 'label', labelId: '3', name: 'Coach', color: 4, deleted: false,
  });
  assert.equal(normalizeLabelEdit({ id: '' }), null);
  assert.equal(normalizeLabelEdit({ id: 'deleted', deleted: true }).deleted, true);
});

test('only chat label membership with a verified phone is mirrored', async () => {
  const add = await normalizeLabelAssociation({
    type: 'add', association: { type: 'label_jid', labelId: '3', chatId: '201012345678@s.whatsapp.net' },
  });
  assert.deepEqual(add, {
    kind: 'labelAssociation', labelId: '3',
    contactKey: '201012345678@s.whatsapp.net', action: 'add',
  });
  const removed = await normalizeLabelAssociation({
    type: 'remove', association: { type: 'label_jid', labelId: '3', chatId: '123@lid' },
  }, { resolveLidPn: async () => '201012345678@s.whatsapp.net' });
  assert.equal(removed.action, 'remove');
  assert.equal(removed.contactKey, add.contactKey);
});

test('fail closed for unknown LIDs, groups and message-level associations', async () => {
  for (const chatId of ['123@lid', '120363@g.us', 'status@broadcast', '123@newsletter']) {
    assert.equal(await normalizeLabelAssociation({
      type: 'add', association: { type: 'label_jid', labelId: '3', chatId },
    }), null);
  }
  assert.equal(await normalizeLabelAssociation({
    type: 'add', association: { type: 'label_message', labelId: '3',
      chatId: '201012345678@s.whatsapp.net', messageId: 'a' },
  }), null);
  assert.equal(await normalizeLabelAssociation({
    type: 'unknown', association: { type: 'label_jid', labelId: '3',
      chatId: '201012345678@s.whatsapp.net' },
  }), null);
});
