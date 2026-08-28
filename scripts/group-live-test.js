#!/usr/bin/env node
/**
 * Live test: create a WhatsApp group (optional) and send a message to it.
 *
 * Usage:
 *   node scripts/group-live-test.js
 *
 * Env:
 *   WHATSAPP_TEST_GROUP_NAME   - use existing group instead of creating one
 *   WHATSAPP_TEST_GROUP_INVITE - send via invite link instead of name
 *   WHATSAPP_TEST_MEMBER_PHONE - phone to add when creating a new group (required for create)
 *   WHATSAPP_TEST_MESSAGE      - message body (default: timestamped test message)
 */
require('dotenv').config();

const whatsappService = require('../services/whatsappService');

async function main() {
  const existingName = process.env.WHATSAPP_TEST_GROUP_NAME;
  const inviteLink = process.env.WHATSAPP_TEST_GROUP_INVITE;
  const memberPhone = process.env.WHATSAPP_TEST_MEMBER_PHONE;
  const message =
    process.env.WHATSAPP_TEST_MESSAGE ||
    `Cursor group test ${new Date().toISOString()}`;

  console.log('Checking WhatsApp status...');
  const status = await whatsappService.getStatus();
  console.log(status);

  let groupName = existingName;

  if (!inviteLink && !groupName) {
    if (!memberPhone) {
      console.error(
        'Set WHATSAPP_TEST_MEMBER_PHONE to create a test group, or set WHATSAPP_TEST_GROUP_NAME / WHATSAPP_TEST_GROUP_INVITE.',
      );
      process.exit(1);
    }

    groupName = `Cursor Test ${Date.now()}`;
    console.log(`Creating group "${groupName}" with member ${memberPhone}...`);
    const created = await whatsappService.createGroupAndWait({
      groupName,
      memberPhones: [memberPhone],
    });

    if (!created.success) {
      console.error('Failed to create group:', created);
      process.exit(1);
    }
    console.log('Group created:', created);
  }

  const target = inviteLink
    ? { groupInviteLink: inviteLink }
    : { groupName };

  console.log('Sending group message...', target);
  const sent = await whatsappService.sendGroupMessageAndWait(target, message);
  console.log('Send result:', sent);

  if (!sent.success) {
    process.exit(1);
  }

  console.log('Group live test completed successfully.');
}

main()
  .catch((error) => {
    console.error('Group live test failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await whatsappService.closeDriver();
    } catch (_) {
      /* ignore */
    }
  });
