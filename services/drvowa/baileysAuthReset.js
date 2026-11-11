'use strict';

const fs = require('fs');

// Baileys multi-file auth stores credentials and cryptographic keys as files
// in the managed account directory. Never delete durable message spools,
// label data, idempotency ledgers, or other files alongside them.
const AUTH_FILE = /^(?:creds|(?:pre-key|session|sender-key|sender-key-memory|app-state-sync-key|app-state-sync-version|device-list|tctoken|lid-mapping)-.+)\.json$/;

function clearLoggedOutAuth(authDir) {
  if (!fs.existsSync(authDir)) return 0;
  let cleared = 0;
  for (const entry of fs.readdirSync(authDir, { withFileTypes: true })) {
    if (!entry.isFile() || !AUTH_FILE.test(entry.name)) continue;
    fs.unlinkSync(require('path').join(authDir, entry.name));
    cleared += 1;
  }
  return cleared;
}

module.exports = { clearLoggedOutAuth };
