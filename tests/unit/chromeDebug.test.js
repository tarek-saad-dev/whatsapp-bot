import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const {
  isWhatsAppPageTarget,
  listPageTargets,
} = require('../../services/chromeDebug');

describe('chromeDebug', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it('detects WhatsApp page targets', () => {
    expect(isWhatsAppPageTarget({ type: 'page', url: 'https://web.whatsapp.com/' })).toBe(true);
    expect(isWhatsAppPageTarget({ type: 'browser_ui', url: 'chrome://omnibox-popup.top-chrome/' })).toBe(false);
  });

  it('lists WhatsApp page targets from /json/list', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/json/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { type: 'page', url: 'https://web.whatsapp.com/', id: 'A' },
          { type: 'browser_ui', url: 'chrome://omnibox-popup.top-chrome/', id: 'B' },
        ]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(19222, '127.0.0.1', resolve));

    const pages = await listPageTargets({ host: '127.0.0.1', port: 19222 });
    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe('A');
  });
});
