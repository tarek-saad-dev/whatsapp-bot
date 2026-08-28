'use strict';

const INVITE_LINK_REGEX = /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i;
const ACCEPT_CODE_REGEX = /accept\?code=([A-Za-z0-9_-]+)/i;

/**
 * Extract invite code from a WhatsApp group invite URL.
 * Supports chat.whatsapp.com/... and web.whatsapp.com/accept?code=...
 */
function parseGroupInviteLink(link) {
  const raw = String(link || '').trim();
  if (!raw) return null;

  const chatMatch = raw.match(INVITE_LINK_REGEX);
  if (chatMatch) return chatMatch[1];

  const acceptMatch = raw.match(ACCEPT_CODE_REGEX);
  if (acceptMatch) return acceptMatch[1];

  return null;
}

function normalizeGroupName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  if (trimmed.length > 200) return null;
  return trimmed;
}

function groupWebUrlFromInviteLink(link) {
  const code = parseGroupInviteLink(link);
  if (!code) return null;
  return `https://web.whatsapp.com/accept?code=${code}`;
}

module.exports = {
  parseGroupInviteLink,
  normalizeGroupName,
  groupWebUrlFromInviteLink,
};
