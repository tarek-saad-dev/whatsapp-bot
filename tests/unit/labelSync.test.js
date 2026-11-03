'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normalizeLabelEdit, normalizeLabelAssociation } = require('../../services/transport/baileys/labelSync');

describe('Baileys V6 label events', () => {
  it('normalizes label metadata and deletion', () => {
    expect(normalizeLabelEdit({ id: '1', name: 'Coach', deleted: true }))
      .toMatchObject({ kind: 'label', labelId: '1', name: 'Coach', deleted: true });
  });
  it('accepts only chat labels with resolved phone identities', () => {
    const body = { type: 'add', association: {
      type: 'label_jid', labelId: '2', chatId: '123@lid',
    }};
    expect(normalizeLabelAssociation(body, () => '201012345678@s.whatsapp.net'))
      .toMatchObject({ contactKey: '201012345678@s.whatsapp.net', action: 'add' });
    expect(normalizeLabelAssociation(body)).toBeNull();
    expect(normalizeLabelAssociation({ ...body,
      association: { ...body.association, chatId: '123@g.us' } })).toBeNull();
    expect(normalizeLabelAssociation({ ...body,
      association: { ...body.association, type: 'label_message' } })).toBeNull();
  });
});
