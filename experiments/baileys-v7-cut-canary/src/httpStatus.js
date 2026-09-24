'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal local status/QR/send HTTP server (loopback only).
 */
export function createStatusServer({
  host = '127.0.0.1',
  port = 3017,
  getSnapshot,
  getQrPngPath,
  onSend = null,
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
      if (req.method === 'POST' && url.pathname === '/send') {
        if (typeof onSend !== 'function') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'outbound_unavailable' }));
          return;
        }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);
        if (raw.length > 4096) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'body_too_large' }));
          return;
        }
        let body;
        try {
          body = JSON.parse(raw.toString('utf8') || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'invalid_json' }));
          return;
        }
        try {
          const result = await onSend(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
          const code = err?.code || 'SEND_FAILED';
          const status = code === 'DESTINATION_NOT_ALLOWED' || code === 'OUTBOUND_DISABLED' ? 403 : 500;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: code }));
        }
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
