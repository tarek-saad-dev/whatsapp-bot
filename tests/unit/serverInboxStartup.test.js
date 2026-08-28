import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const whatsappService = require('../../services/whatsappService');
const { startServer } = require('../../server.js');

describe('server startup with inbox listener enabled', () => {
  const envBackup = { WHATSAPP_INBOX_LISTEN: process.env.WHATSAPP_INBOX_LISTEN, PORT: process.env.PORT };

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.WHATSAPP_INBOX_LISTEN = envBackup.WHATSAPP_INBOX_LISTEN;
    process.env.PORT = envBackup.PORT;
  });

  it('startInboxListener returns a Promise (server.js .catch is valid)', async () => {
    const result = whatsappService.startInboxListener({ initDriver: false });
    expect(result).toBeInstanceOf(Promise);
    expect(typeof result.catch).toBe('function');
    const status = await result;
    expect(status).toMatchObject({ listening: expect.any(Boolean), mode: 'phase1.1' });
  });

  it('startServer completes when WHATSAPP_INBOX_LISTEN=true', async () => {
    process.env.WHATSAPP_INBOX_LISTEN = 'true';
    process.env.PORT = '19876';

    vi.spyOn(whatsappService, 'startInboxListener').mockResolvedValue({
      listening: true,
      mode: 'phase1.1',
    });

    const server = await startServer();
    expect(whatsappService.startInboxListener).toHaveBeenCalledWith({ initDriver: true });
    expect(server).toBeDefined();

    await new Promise((resolve) => server.close(resolve));
  });

  it('startServer survives async startInboxListener rejection', async () => {
    process.env.WHATSAPP_INBOX_LISTEN = 'true';
    process.env.PORT = '19877';

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(whatsappService, 'startInboxListener').mockRejectedValue(new Error('Chrome unavailable'));

    const server = await startServer();
    expect(server).toBeDefined();

    await new Promise((resolve) => setImmediate(resolve));
    expect(consoleSpy).toHaveBeenCalledWith('Failed to start inbox listener:', 'Chrome unavailable');

    await new Promise((resolve) => server.close(resolve));
  });
});
