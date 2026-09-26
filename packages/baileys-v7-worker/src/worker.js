'use strict';

/**
 * Production Baileys v7 worker — one process owns one accountKey + authDir.
 * Communicates with the CommonJS supervisor via Node IPC.
 */

import fs from 'node:fs';
import path from 'node:path';
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
import { buildV7InboundDto } from './dto.js';
import { createSaasDeliverer, buildIngestUrl } from './saasDeliver.js';
import { createCryptoHealth } from './cryptoHealth.js';
import { buildV7OutboundObservation } from './outboundObserve.js';

const logger = pino({ level: process.env.V7_WORKER_LOG_LEVEL || 'warn' });

const ACCOUNT_KEY = String(process.env.V7_ACCOUNT_KEY || '').trim();
const AUTH_DIR = String(process.env.V7_AUTH_DIR || '').trim();
const S2S_ENABLED = String(process.env.V7_S2S_ENABLED || 'true').toLowerCase() !== 'false';

if (!ACCOUNT_KEY || !AUTH_DIR) {
  // eslint-disable-next-line no-console
  console.error('[v7-worker] fatal missing V7_ACCOUNT_KEY or V7_AUTH_DIR');
  process.exit(1);
}

const cryptoHealth = createCryptoHealth();

const snapshot = {
  accountKey: ACCOUNT_KEY,
  runtimeEngine: 'BAILEYS_V7',
  baileysVersion: '7.0.0-rc14',
  state: 'STARTING',
  ready: false,
  qrAvailable: false,
  lastConnectedAt: null,
  lastDisconnectAt: null,
  lastDisconnectCode: null,
  lastErrorCode: null,
  reconnectAttempts: 0,
  authDir: AUTH_DIR,
  qr: null,
};

let sock = null;
let stopping = false;
let saveCreds = null;
let deliverer = null;
/** @type {Promise<void>|null} */
let sendChain = Promise.resolve();

function emitStatus() {
  const status = getStatus();
  if (typeof process.send === 'function') {
    process.send({ type: 'status', status });
  }
}

function setState(state, extra = {}) {
  snapshot.state = state;
  snapshot.ready = state === 'READY';
  Object.assign(snapshot, extra);
  emitStatus();
}

function getStatus() {
  return {
    accountKey: ACCOUNT_KEY,
    runtimeEngine: 'BAILEYS_V7',
    baileysVersion: '7.0.0-rc14',
    state: snapshot.state,
    ready: snapshot.ready,
    qrAvailable: snapshot.qrAvailable,
    lastConnectedAt: snapshot.lastConnectedAt,
    lastDisconnectAt: snapshot.lastDisconnectAt,
    lastDisconnectCode: snapshot.lastDisconnectCode,
    lastErrorCode: snapshot.lastErrorCode,
    reconnectAttempts: snapshot.reconnectAttempts,
    authDir: AUTH_DIR,
    cryptoHealth: cryptoHealth.snapshot(),
    inboundDelivery: deliverer ? deliverer.getStats() : null,
  };
}

async function writeQr(qr) {
  if (!qr) return;
  snapshot.qr = qr;
  snapshot.qrAvailable = true;
  const pngPath = path.join(AUTH_DIR, 'v7-qr.png');
  try {
    await QRCode.toFile(pngPath, qr, { type: 'png', width: 320, margin: 2 });
  } catch {
    /* ignore png failures; string QR still available via IPC */
  }
  setState('QR_REQUIRED');
}

function shouldIgnoreUpsert(msg) {
  const key = msg?.key || {};
  // fromMe is NOT discarded here — handled as outbound observation.
  const remote = String(key.remoteJid || '');
  if (remote.endsWith('@g.us')) return 'group';
  if (remote === 'status@broadcast') return 'status';
  return null;
}

function ownAccountDigits() {
  try {
    const id = sock?.user?.id || sock?.authState?.creds?.me?.id || '';
    const digits = String(id).split(':')[0].split('@')[0].replace(/\D/g, '');
    return /^\d{8,15}$/.test(digits) ? digits : null;
  } catch {
    return null;
  }
}

async function maybeObserveOutbound(msg) {
  const resolveLidPn = async (lidJid) => {
    try {
      return await sock?.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
    } catch {
      return null;
    }
  };

  const built = await buildV7OutboundObservation(msg, {
    resolveLidPn,
    ownDigits: ownAccountDigits(),
  });
  if (!built.ok) {
    // eslint-disable-next-line no-console
    console.log('[v7-worker-outbound] skip', JSON.stringify({ reason: built.reason }));
    return;
  }
  if (typeof process.send === 'function') {
    process.send({
      type: 'outboundObserved',
      observation: built.observation,
    });
  }
  // eslint-disable-next-line no-console
  console.log('[v7-worker-outbound] observed', JSON.stringify({
    providerMessageId: built.observation.providerMessageId,
    textLength: built.observation.text ? String(built.observation.text).length : 0,
  }));
}

function normalizePhoneDigits(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('01')) {
    digits = `2${digits}`;
  }
  return digits;
}

async function maybeDeliver(msg, upsertType) {
  if (!deliverer) return;
  if (String(upsertType) !== 'notify') return;

  const resolveLidPn = async (lidJid) => {
    try {
      return await sock?.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
    } catch {
      return null;
    }
  };

  const built = await buildV7InboundDto(msg, {
    accountKey: ACCOUNT_KEY,
    upsertType,
    resolveLidPn,
  });
  if (!built.ok) return;
  await deliverer.deliver(built.dto);
}

function onMessagesUpsert(upsert) {
  const type = upsert?.type || 'unknown';
  const messages = Array.isArray(upsert?.messages) ? upsert.messages : [];
  for (const msg of messages) {
    const key = msg?.key || {};
    const summary = summarizeInbound(msg);
    summary.upsertType = type;

    // Outbound observation path (manual phone / API echo) — never inbound ingest.
    if (key.fromMe) {
      summary.decryptOutcome = 'outbound_observation_candidate';
      logInboundSafe(summary, type);
      maybeObserveOutbound(msg).catch(() => {});
      continue;
    }

    const ignore = shouldIgnoreUpsert(msg);
    if (ignore === 'group' || ignore === 'status') {
      logInboundSafe(summary, type);
      continue;
    }
    const failurePmid = summary.messageId || msg?.key?.id || null;
    if (summary.plaintextPresent === 'YES') {
      cryptoHealth.recordPlaintext();
      maybeDeliver(msg, type).catch(() => {});
    } else if (summary.decryptOutcome === 'ciphertext_or_stub' || summary.stubType === 2) {
      cryptoHealth.recordDecryptFailure({
        absentFromNode: summary.stubType === 2,
        providerMessageId: failurePmid,
      });
    } else if (summary.decryptOutcome === 'no_message_node' || summary.decryptOutcome === 'no_plaintext') {
      cryptoHealth.recordDecryptFailure({
        absentFromNode: summary.decryptOutcome === 'no_message_node',
        providerMessageId: failurePmid,
      });
    }
    logInboundSafe(summary, type);
    emitStatus();
  }
}

async function startSocket() {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const { state, saveCreds: save } = await useMultiFileAuthState(AUTH_DIR);
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
    browser: Browsers.ubuntu('DRVOWA-Baileys-V7'),
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
        snapshot.lastErrorCode = 'QR_WRITE_FAILED';
        setState(snapshot.state === 'QR_REQUIRED' ? 'QR_REQUIRED' : 'ERROR');
      }
    }
    if (connection === 'open') {
      snapshot.qr = null;
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
      snapshot.qr = null;
      snapshot.lastDisconnectAt = new Date().toISOString();
      snapshot.lastDisconnectCode = statusCode || null;
      if (loggedOut) {
        setState('LOGGED_OUT');
        return;
      }
      snapshot.reconnectAttempts += 1;
      setState('DISCONNECTED');
      if (!stopping && snapshot.reconnectAttempts < 20) {
        setTimeout(() => {
          startSocket().catch((e) => {
            snapshot.lastErrorCode = 'RECONNECT_FAILED';
            setState('ERROR');
            // eslint-disable-next-line no-console
            console.error('[v7-worker] reconnect_failed', String(e?.message || e).slice(0, 120));
          });
        }, Math.min(30_000, 1000 * snapshot.reconnectAttempts));
      }
    }
  });
  sock.ev.on('messages.upsert', onMessagesUpsert);
}

function enqueueSend(fn) {
  const run = sendChain.then(fn, fn);
  sendChain = run.then(() => undefined, () => undefined);
  return run;
}

async function handleSend({ phone, message, idempotencyKey }) {
  if (snapshot.state !== 'READY' || !sock) {
    return {
      success: false,
      status: 'failed',
      error: `Account is not READY (state=${snapshot.state})`,
      code: 'NOT_READY',
      httpStatus: 409,
    };
  }
  const digits = normalizePhoneDigits(phone);
  if (!digits || digits.length < 8) {
    return {
      success: false,
      status: 'failed',
      error: 'phone and message are required',
      code: 'INVALID_PAYLOAD',
      httpStatus: 400,
    };
  }
  const text = String(message || '').trim();
  if (!text) {
    return {
      success: false,
      status: 'failed',
      error: 'phone and message are required',
      code: 'INVALID_PAYLOAD',
      httpStatus: 400,
    };
  }

  return enqueueSend(async () => {
    const jid = `${digits}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text });
    let providerMessageId = null;
    if (result && typeof result === 'object') {
      if (result.key && result.key.id) providerMessageId = String(result.key.id);
      else if (Array.isArray(result) && result[0]?.key?.id) {
        providerMessageId = String(result[0].key.id);
      }
    }
    // eslint-disable-next-line no-console
    console.log('[v7-worker-send]', JSON.stringify({
      hasResult: Boolean(result),
      resultType: result == null ? 'null' : typeof result,
      keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 8) : [],
      hasKeyId: Boolean(providerMessageId),
    }));
    return {
      success: Boolean(providerMessageId),
      status: providerMessageId ? 'sent' : 'unknown',
      // managedOutboundSend reads messageId (v6 transport contract)
      messageId: providerMessageId,
      providerMessageId,
      idempotencyKey: idempotencyKey || null,
      code: providerMessageId ? undefined : 'OUTBOUND_RESULT_UNKNOWN',
      error: providerMessageId ? undefined : 'Outbound send completed without providerMessageId',
      httpStatus: providerMessageId ? 200 : 409,
    };
  });
}

async function shutdown() {
  stopping = true;
  setState('STOPPED');
  try {
    sock?.end?.(undefined);
  } catch {
    /* ignore */
  }
  sock = null;
  process.exit(0);
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { type, requestId } = msg;
  try {
    if (type === 'getStatus') {
      process.send?.({ type: 'reply', requestId, ok: true, status: getStatus() });
      return;
    }
    if (type === 'getQr') {
      process.send?.({
        type: 'reply',
        requestId,
        ok: true,
        qr: {
          accountKey: ACCOUNT_KEY,
          qr: snapshot.qr || null,
          qrAvailable: Boolean(snapshot.qr),
        },
      });
      return;
    }
    if (type === 'send') {
      const result = await handleSend(msg);
      process.send?.({ type: 'reply', requestId, ok: true, result });
      return;
    }
    if (type === 'stop') {
      process.send?.({ type: 'reply', requestId, ok: true, status: getStatus() });
      await shutdown();
      return;
    }
  } catch (err) {
    process.send?.({
      type: 'reply',
      requestId,
      ok: false,
      error: String(err?.message || err).slice(0, 200),
      code: err?.code || 'WORKER_ERROR',
    });
  }
});

async function main() {
  const ingestUrl = buildIngestUrl(process.env.DRVOWA_SAAS_BASE_URL);
  const runtimeToken = process.env.DRVOWA_RUNTIME_TOKEN || '';
  deliverer = createSaasDeliverer({
    accountKey: ACCOUNT_KEY,
    ingestUrl,
    runtimeToken,
    enabled: S2S_ENABLED,
  });

  // eslint-disable-next-line no-console
  console.log('[v7-worker] starting', JSON.stringify({
    accountKeyPrefix: ACCOUNT_KEY.slice(0, 10),
    s2sConfigured: deliverer.configured(),
  }));

  setState('STARTING');
  await startSocket();

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[v7-worker] fatal', String(err?.message || err).slice(0, 200));
  process.exit(1);
});
