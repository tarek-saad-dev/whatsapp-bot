import { describe, it, expect, beforeAll } from 'vitest';
import * as whatsappService from '../../services/whatsappService.js';

const ENABLED = process.env.ENABLE_REAL_WHATSAPP_TEST === 'true';
const APPROVED_NUMBER = process.env.TEST_WHATSAPP_NUMBER || '201557994946';

(ENABLED ? describe : describe.skip)('Controlled real WhatsApp send test', () => {
  beforeAll(async () => {
    if (process.env.DISABLE_REAL_WHATSAPP === 'true') {
      throw new Error(
        'DISABLE_REAL_WHATSAPP is true. Set it to false before running the real send test.'
      );
    }
    // Wait for WhatsApp Web to be ready (requires interactive Chrome session).
    await whatsappService.initializeDriver(true);
  });

  it('sends exactly one message to the approved test number', async () => {
    const isReady = await whatsappService.isReady();
    expect(isReady).toBe(true);

    const result = await whatsappService.sendMessage(
      APPROVED_NUMBER,
      'Controlled real WhatsApp test message from automated test suite.'
    );

    expect(result.success).toBe(true);

    const queue = whatsappService.getQueueInfo();
    expect(queue.length).toBeLessThanOrEqual(1);
  });
});
