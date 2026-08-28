import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { clickChatRowNative } = require('../../services/inbox/whatsappInboxAdapter');

describe('clickChatRowNative', () => {
  it('uses Selenium element click instead of executeScript DOM click', async () => {
    const click = vi.fn().mockResolvedValue(undefined);
    const drv = {
      findElement: vi.fn().mockResolvedValue({ click }),
    };

    const ok = await clickChatRowNative(drv, 'Ahmed');
    expect(ok).toBe(true);
    expect(drv.findElement).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('returns false when the chat row is missing', async () => {
    const drv = {
      findElement: vi.fn().mockRejectedValue(new Error('not found')),
    };
    const ok = await clickChatRowNative(drv, 'Missing');
    expect(ok).toBe(false);
  });
});
