'use strict';

/**
 * Controlled outbound for Phase B canary only.
 * Hard-allows a single destination suffix (test peer).
 */

export function createOutboundGate({
  allowedPhoneDigits = '201557994946',
  enabled = false,
} = {}) {
  const allowed = String(allowedPhoneDigits).replace(/\D/g, '');

  function normalizePhone(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    // Egypt local 01xxxxxxxxx → 201xxxxxxxxx
    if (digits.length === 11 && digits.startsWith('01')) {
      digits = `2${digits}`;
    }
    return digits;
  }

  function assertAllowed(phone) {
    if (!enabled) {
      const err = new Error('outbound_disabled');
      err.code = 'OUTBOUND_DISABLED';
      throw err;
    }
    const digits = normalizePhone(phone);
    if (digits !== allowed) {
      const err = new Error('destination_not_allowed');
      err.code = 'DESTINATION_NOT_ALLOWED';
      throw err;
    }
    return digits;
  }

  return { assertAllowed, normalizePhone, allowed };
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 */
export async function sendControlledText(sock, { phone, message, gate }) {
  const digits = gate.assertAllowed(phone);
  const text = String(message || '').trim();
  if (!text || text.length > 500) {
    const err = new Error('invalid_message');
    err.code = 'INVALID_MESSAGE';
    throw err;
  }
  const jid = `${digits}@s.whatsapp.net`;
  const result = await sock.sendMessage(jid, { text });
  const providerMessageId = result?.key?.id || null;
  return {
    success: true,
    providerMessageId,
    // do not return jid/phone
  };
}
