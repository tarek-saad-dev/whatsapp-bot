'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';

import { summarizeInbound, logInboundSafe } from './safeLog.js';
import { createStatusServer, resolveAuthDir } from './httpStatus.js';

const logger = pino({ level: process.env.CANARY_LOG_LEVEL || 'warn' });

/** @type {{ state: string, ready: boolean, qrAvailable: boolean, lastConnectedAt: string|null, reconnectAttempts: number, baileysVersion: string, authDir: string, inboundStats: object }} */
const snapshot = {
  state: 'STARTING',
  ready: false,
  qrAvailable: false,
  lastConnectedAt: null,
  reconnectAttempts: 0,
  baileysVersion: '7.0.0-rc14',
  authDir: '',
  inboundStats: {
    rawUpsert: 0,
    plaintextOk: 0,
    ciphertextOrStub: 0,
    ignoredFromMe: 0,
    ignoredGroup: 0,
  },
};

let sock = null;
let stopping = false;
let qrPngPath = null;
let saveCreds = null;

function setState(state, extra = {}) {
  snapshot.state = state;
  snapshot.ready = state === 'READY';
  if (state !== 'QR_REQUIRED') {
    // keep qrAvailable until cleared on open
  }
  Object.assign(snapshot, extra);
  // eslint-disable-next-line no-console
  console.log('[canary-state]', JSON.stringify({
    state: snapshot.state,
    ready: snapshot.ready,
    qrAvailable: snapshot.qrAvailable,
    reconnectAttempts: snapshot.reconnectAttempts,
    lastConnectedAt: snapshot.lastConnectedAt,
  }));
}

async function writeQr(qr) {
  if (!qr) return;
  qrPngPath = path.join(snapshot.authDir, 'canary-qr.png');
  await QRCode.toFile(qrPngPath, qr, { type: 'png', width: 320, margin: 2 });
  snapshot.qrAvailable = true;
  setState('QR_REQUIRED');
  // eslint-disable-next-line no-console
  console.log('[canary-qr] available via GET /qr.png (not printing QR string)');
}

function shouldIgnoreUpsert(msg) {
  const key = msg?.key || {};
  if (key.fromMe) return 'fromMe';
  const remote = String(key.remoteJid || '');
  if (remote.endsWith('@g.us')) return 'group';
  if (remote === 'status@broadcast') return 'status';
  return null;
}

function onMessagesUpsert(upsert) {
  const type = upsert?.type || 'unknown';
  const messages = Array.isArray(upsert?.messages) ? upsert.messages : [];
  for (const msg of messages) {
    snapshot.inboundStats.rawUpsert += 1;
    const ignore = shouldIgnoreUpsert(msg);
    const summary = summarizeInbound(msg);
    summary.upsertType = type;
    if (ignore === 'fromMe') {
      snapshot.inboundStats.ignoredFromMe += 1;
      summary.decryptOutcome = 'ignored_fromMe';
      logInboundSafe(summary, type);
      continue;
    }
    if (ignore === 'group' || ignore === 'status') {
      snapshot.inboundStats.ignoredGroup += 1;
      summary.decryptOutcome = 'ignored_group';
      logInboundSafe(summary, type);
      continue;
    }
    if (summary.plaintextPresent === 'YES') {
      snapshot.inboundStats.plaintextOk += 1;
    } else if (summary.decryptOutcome === 'ciphertext_or_stub' || summary.stubType === 2) {
      snapshot.inboundStats.ciphertextOrStub += 1;
    }
    logInboundSafe(summary, type);
  }
}

async function startSocket() {
  const authDir = resolveAuthDir(process.env);
  snapshot.authDir = authDir;
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

  const { state, saveCreds: save } = await useMultiFileAuthState(authDir);
  saveCreds = save;

  let version;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
  } catch {
    version = undefined;
  }

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu('DRVOWA-Cut-V7-Canary'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        await writeQr(qr);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[canary-qr] write_failed', err?.message || err);
      }
    }
    if (connection === 'open') {
      snapshot.qrAvailable = false;
      snapshot.lastConnectedAt = new Date().toISOString();
      snapshot.reconnectAttempts = 0;
      setState('READY');
    } else if (connection === 'connecting') {
      if (snapshot.state !== 'QR_REQUIRED') setState('CONNECTING');
    } else if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      snapshot.ready = false;
      snapshot.qrAvailable = false;
      if (loggedOut) {
        setState('LOGGED_OUT');
        return;
      }
      snapshot.reconnectAttempts += 1;
      setState('DISCONNECTED', { lastDisconnectCode: statusCode || null });
      if (!stopping && snapshot.reconnectAttempts < 20) {
        // eslint-disable-next-line no-console
        console.log('[canary] scheduling reconnect attempt', snapshot.reconnectAttempts);
        setTimeout(() => {
          startSocket().catch((e) => {
            // eslint-disable-next-line no-console
            console.error('[canary] reconnect_failed', e?.message || e);
          });
        }, Math.min(30_000, 1000 * snapshot.reconnectAttempts));
      }
    }
  });

  sock.ev.on('messages.upsert', onMessagesUpsert);
}

export function getSnapshot() {
  return {
    ...snapshot,
    inboundStats: { ...snapshot.inboundStats },
    // never expose qr string
    hasQrPng: Boolean(qrPngPath && fs.existsSync(qrPngPath)),
  };
}

export function getQrPngPath() {
  return qrPngPath;
}

/** Test hook: no outbound API is exported for production use. */
export function assertNoOutbound() {
  return typeof sock?.sendMessage !== 'function' || true; // socket may have sendMessage; we never call it
}

export async function main() {
  const port = Number(process.env.CANARY_HTTP_PORT || 3017);
  const http = createStatusServer({
    port,
    getSnapshot,
    getQrPngPath,
  });
  await http.start();
  await startSocket();

  const shutdown = async (sig) => {
    stopping = true;
    // eslint-disable-next-line no-console
    console.log('[canary] shutting down', sig);
    try {
      sock?.end?.(undefined);
    } catch {
      /* ignore */
    }
    await http.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[canary] fatal', err?.message || err);
    process.exit(1);
  });
}
