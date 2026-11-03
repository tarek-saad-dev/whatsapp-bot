'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeLabelEdit, normalizeLabelAssociation } =
  require('../services/transport/baileys/labelSync');
const { createLabelSyncDelivery } = require('../services/drvowa/labelSyncDelivery');

test('V6 label adapter never includes groups, message labels or unresolved LIDs', () => {
  assert.equal(normalizeLabelEdit({ id: 'coach', name: ' Coach ' }).name, 'Coach');
  const assoc = { type: 'add', association: { type: 'label_jid',
    labelId: 'coach', chatId: '2000000@lid' } };
  assert.equal(normalizeLabelAssociation(assoc), null);
  assert.equal(normalizeLabelAssociation({
    ...assoc, association: { ...assoc.association, chatId: '123456789@g.us' },
  }), null);
  const valid = normalizeLabelAssociation(assoc, () => '201012345678@s.whatsapp.net');
  assert.equal(valid.contactKey, '201012345678@s.whatsapp.net');
});

test('V6 label spool retains add-remove-add order across process recreation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-label-'));
  const prev = process.env.DRVOWA_RUNTIME_TOKEN;
  delete process.env.DRVOWA_RUNTIME_TOKEN; // capture-only, zero outbound network activity
  try {
    const a = createLabelSyncDelivery({ accountKey: 'test', authDir: dir });
    const event = { kind: 'labelAssociation', labelId: 'coach',
      contactKey: '201012345678@s.whatsapp.net', action: 'add' };
    assert.equal(a.capture(event), true);
    assert.equal(a.capture({ ...event, action: 'remove' }), true);
    assert.equal(a.capture(event), true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'labels-sync.json'), 'utf8'));
    assert.equal(saved.records.length, 3);
    assert.equal(new Set(saved.records.map(r => r.id)).size, 3);
    const restarted = createLabelSyncDelivery({ accountKey: 'test', authDir: dir });
    assert.equal(restarted.getStatus().pending, 3);
  } finally {
    if (prev === undefined) delete process.env.DRVOWA_RUNTIME_TOKEN;
    else process.env.DRVOWA_RUNTIME_TOKEN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
