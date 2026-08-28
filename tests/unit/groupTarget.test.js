import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  parseGroupInviteLink,
  normalizeGroupName,
  groupWebUrlFromInviteLink,
} = require('../../services/groupTarget');

describe('groupTarget', () => {
  it('parses chat.whatsapp.com invite links', () => {
    expect(parseGroupInviteLink('https://chat.whatsapp.com/AbCdEfGhIjK')).toBe('AbCdEfGhIjK');
  });

  it('parses web.whatsapp.com accept links', () => {
    expect(parseGroupInviteLink('https://web.whatsapp.com/accept?code=AbCdEfGhIjK')).toBe('AbCdEfGhIjK');
  });

  it('rejects invalid invite links', () => {
    expect(parseGroupInviteLink('https://example.com/group')).toBeNull();
  });

  it('normalizes group names', () => {
    expect(normalizeGroupName('  Sales Team  ')).toBe('Sales Team');
    expect(normalizeGroupName('')).toBeNull();
  });

  it('builds web URL from invite link', () => {
    expect(groupWebUrlFromInviteLink('https://chat.whatsapp.com/AbCdEfGhIjK')).toBe(
      'https://web.whatsapp.com/accept?code=AbCdEfGhIjK',
    );
  });
});
