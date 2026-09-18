'use strict';

/**
 * DRVOWA transport inbound callback DTO (Phase 2A).
 * Production delivery to DRVOWA SaaS is NOT enabled yet.
 *
 * {
 *   accountKey,       // from trusted runtime state — never from client body
 *   provider,         // "baileys"
 *   providerMessageId,
 *   externalContactKey,
 *   fromMe,
 *   isGroup,
 *   messageTimestamp,
 *   receivedAt,
 *   upsertType,
 *   content
 * }
 *
 * No BusinessID.
 */

function buildDrvowaInboundDto({
  accountKey,
  providerMessageId,
  externalContactKey,
  fromMe = false,
  isGroup = false,
  messageTimestamp = null,
  receivedAt = null,
  upsertType = 'notify',
  content = null,
}) {
  return {
    accountKey,
    provider: 'baileys',
    providerMessageId: providerMessageId || null,
    externalContactKey: externalContactKey || null,
    fromMe: Boolean(fromMe),
    isGroup: Boolean(isGroup),
    messageTimestamp: messageTimestamp == null ? null : messageTimestamp,
    receivedAt: receivedAt || new Date().toISOString(),
    upsertType: upsertType || 'notify',
    content,
  };
}

module.exports = {
  buildDrvowaInboundDto,
};
