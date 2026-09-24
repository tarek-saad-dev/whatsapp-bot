'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal local status/QR HTTP server (loopback only).
 * No SaaS. No outbound WhatsApp.
 */
export function createStatusServer({
  host = '127.0.0.1',
  port = 3017,
  getSnapshot,
  getQrPngPath,
  logger = console,
} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${host}:${port}`);
      if (req.method === 'GET' && url.pathname === '/status') {
        const snap = getSnapshot();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(snap, null, 2));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/qr.png') {
        const pngPath = getQrPngPath();
        if (!pngPath || !fs.existsSync(pngPath)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'qr_unavailable' }));
          return;
        }
        const buf = fs.readFileSync(pngPath);
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length });
        res.end(buf);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (err) {
      logger.error?.('[canary-http]', err?.message || err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          logger.log?.(`[canary-http] listening http://${host}:${port}`);
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function resolveAuthDir(env = process.env) {
  const dir = env.CANARY_AUTH_DIR || '/home/whatsapp/canary-auth/cut-salon-v7';
  const resolved = path.resolve(dir);
  const forbidden = [
    '/home/whatsapp/whatsapp-bot/data/baileys-auth-accounts',
    '/home/whatsapp/whatsapp-bot/data/baileys-auth',
  ];
  for (const f of forbidden) {
    const fr = path.resolve(f);
    if (resolved === fr || resolved.startsWith(`${fr}${path.sep}`)) {
      throw new Error(`CANARY_AUTH_DIR overlaps production auth: ${resolved}`);
    }
  }
  return resolved;
}
