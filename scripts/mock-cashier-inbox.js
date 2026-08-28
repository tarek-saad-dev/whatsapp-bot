#!/usr/bin/env node
'use strict';

/**
 * Minimal mock Cashier inbox endpoint for Phase 1 smoke tests.
 * Usage: node scripts/mock-cashier-inbox.js
 */
const http = require('http');

const PORT = Number(process.env.MOCK_CASHIER_PORT || 4010);
const TOKEN = process.env.WHATSAPP_INBOX_WEBHOOK_TOKEN || 'test-token';
const rows = new Map();

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/internal/messaging/inbox/whatsapp') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    return;
  }

  const auth = req.headers.authorization || '';
  if (TOKEN && auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const event = JSON.parse(body || '{}');
      const id = event.providerMessageId;
      const duplicate = rows.has(id);
      if (!duplicate) rows.set(id, event);
      res.writeHead(duplicate ? 200 : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, duplicate }));
      console.log(`[mock-cashier] duplicate=${duplicate} id=${id} text=${JSON.stringify(String(event.text || '').slice(0, 60))}`);
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Mock Cashier inbox listening on http://127.0.0.1:${PORT}/api/internal/messaging/inbox/whatsapp`);
  console.log(`Stored rows: ${rows.size}`);
});

module.exports = { server, rows };
