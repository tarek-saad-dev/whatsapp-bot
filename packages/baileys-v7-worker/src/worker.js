'use strict';

/**
 * Production Baileys v7 worker — one process owns one accountKey + authDir.
 * Communicates with the CommonJS supervisor via Node IPC.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeMirrorChat, normalizeMirrorMessage } from './mirrorSync.js';
import { normalizeLabelEdit, normalizeLabelAssociation } from './labelSync.js';
import { createDurableMirrorSpool } from './durableMirrorSpool.js';
import { createHistoryPrivacyPolicy, allowsMirrorEvent, allowsMediaEvent } from './historyPrivacy.js';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadMediaMessage,
  generateMessageIDV2,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';

import { summarizeInbound, logInboundSafe } from './safeLog.js';
import { buildV7InboundDto } from './dto.js';
import { createSaasDeliverer, buildIngestUrl } from './saasDeliver.js';
import { createCryptoHealth } from './cryptoHealth.js';
import { createRetryStore } from './retryStore.js';
import { createPendingRetryBridge } from './pendingRetryBridge.js';
import { createDeliveryEvidence } from './deliveryEvidence.js';
import { createPeerCryptoHealth } from './peerCryptoHealth.js';
import { createReconnectPolicy } from './reconnectPolicy.js';
import { createIncidentMonitor } from './incidentMonitor.js';
import { createIncidentStore } from './incidentStore.js';
import { buildV7OutboundObservation } from './outboundObserve.js';
import { blockedSourceReason } from './sourcePolicy.js';

const logger = pino({ level: process.env.V7_WORKER_LOG_LEVEL || 'warn' });

const ACCOUNT_KEY = String(process.env.V7_ACCOUNT_KEY || '').trim();
const AUTH_DIR = String(process.env.V7_AUTH_DIR || '').trim();
const S2S_ENABLED = String(process.env.V7_S2S_ENABLED || 'true').toLowerCase() !== 'false';
const historyPrivacy = createHistoryPrivacyPolicy({
  accountKey: ACCOUNT_KEY,
  baseUrl: process.env.DRVOWA_SAAS_BASE_URL || 'http://127.0.0.1:3100',
  token: S2S_ENABLED ? process.env.DRVOWA_RUNTIME_TOKEN : '',
  enabled: process.env.V7_HISTORY_SYNC_ENABLED !== 'false',
});

if (!ACCOUNT_KEY || !AUTH_DIR) {
  // eslint-disable-next-line no-console
  console.error('[v7-worker] fatal missing V7_ACCOUNT_KEY or V7_AUTH_DIR');
  process.exit(1);
}

// Same crash-safe atomic inbound spool used by the managed v6 runtime.
const require = createRequire(import.meta.url);
const { createInboxSpool } = require('../../../services/inbox/inboxSpool.js');
const inboundSpool = createInboxSpool({ spoolFile: path.join(AUTH_DIR, 'v7-inbound-spool.json') });
const mirrorSpool = createDurableMirrorSpool({ journalFile: path.join(AUTH_DIR, 'v7-mirror-sync.ndjson') });
const mediaSpool = createDurableMirrorSpool({ journalFile: path.join(AUTH_DIR, 'v7-media-sync.ndjson') });
const MEDIA_DIR = path.join(AUTH_DIR, 'v7-media-pending');
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;
const PRIVACY_SPOOL_PURGE_ENABLED = process.env.V7_PRIVACY_SPOOL_PURGE_ENABLED === 'true';
let mediaChain = Promise.resolve();
let mediaBusy = false;
let mediaTimer = null;
let mirrorBusy = false;
let mirrorTimer = null;
let historyChain = Promise.resolve();
let mirrorErrors = 0;
let labelEventsSeen = 0;
let labelEventsSkipped = 0;
const cryptoHealth = createCryptoHealth();
const retryStore = createRetryStore();
const pendingRetry = createPendingRetryBridge(retryStore);
const deliveryEvidence = createDeliveryEvidence();
const peerCryptoHealth = createPeerCryptoHealth();
const reconnectPolicy = createReconnectPolicy();
const incidentStore = createIncidentStore(path.join(AUTH_DIR, 'v7-reliability-incidents.json'));
const incidentMonitor = createIncidentMonitor({ ...incidentStore, onTransition: event => {
  console.info('[v7-reliability-incident]', JSON.stringify({ accountKeyPrefix: ACCOUNT_KEY.slice(0, 10), ...event }));
} });
let incidentTimer = null;
let reconnectTimer = null;
const retrySweepTimer = setInterval(() => retryStore.sweep(), 15_000);
retrySweepTimer.unref();
let deliveryBusy = false;
let receiptBusy = false;
let inboundTimer = null;
let receiptTimer = null;


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
  deliveryEvidence.setConnected(snapshot.ready);
  peerCryptoHealth.setConnected(snapshot.ready);
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
    reconnectAttempts: reconnectPolicy.snapshot().attempts,
    socketRecovery: reconnectPolicy.snapshot(),
    incidentMonitor: incidentMonitor.snapshot(),
    authDir: AUTH_DIR,
    cryptoHealth: cryptoHealth.snapshot(),
    outboundRetry: { ...retryStore.stats(), early: pendingRetry.stats() },
    deliveryEvidence: deliveryEvidence.snapshot(),
    peerCryptoHealth: peerCryptoHealth.snapshot(),
    // The SaaS dashboard must distinguish a stopped delivery timer from an
    // older runtime omitting the liveness field. V6 already reports "running".
    inboundDelivery: deliverer ? {
      ...deliverer.getStats(),
      ...inboundSpool.getStats(),
      running: Boolean(inboundTimer && !stopping && deliverer.configured()),
    } : null,
    mirrorSync: { ...mirrorSpool.getStats(), errors: mirrorErrors, media: mediaSpool.getStats() },
    labelSync: { coverage: 'EVENT_DRIVEN_PARTIAL', observed: labelEventsSeen,
      skipped: labelEventsSkipped, audienceReady: false },
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
  return blockedSourceReason(msg);
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
  if (built.ok && !(await contactAllowed(built.observation.phone))) return;
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
  if (!built.ok || !(await contactAllowed(built.dto.externalContactKey))) return;
  // Commit before network IO. A crash or network failure cannot lose a plaintext
  // captured message; retries use the same providerMessageId / SaaS dedup key.
  inboundSpool.capture(built.dto, { drvowaDto: built.dto });
  void flushInboundSpool();
}

async function flushInboundSpool() {
  if (deliveryBusy || stopping || !deliverer?.configured()) return;
  deliveryBusy = true;
  try {
    await historyPrivacy.get();
    if (PRIVACY_SPOOL_PURGE_ENABLED) inboundSpool.purgeMatching(item =>
      historyPrivacy.explicitlyBlocked((item.drvowaDto || item.normalizedEvent)?.externalContactKey));
    for (const item of inboundSpool.getPendingForDelivery().filter(item =>
      historyPrivacy.contactAllowed((item.drvowaDto || item.normalizedEvent)?.externalContactKey)).slice(0, 40)) {
      if (!(await contactAllowed((item.drvowaDto || item.normalizedEvent)?.externalContactKey))) continue;
      const outcome = await deliverer.deliver(item.drvowaDto || item.normalizedEvent);
      if (outcome.ok) {
        inboundSpool.markDelivered(item.providerMessageId);
      } else if ([400, 422].includes(outcome.status)) {
        inboundSpool.markQuarantined(item.providerMessageId, {
          reason: outcome.code || 'INGEST_INVALID',
        });
      } else {
        const delayMs = Math.min(60_000, 2000 * Math.pow(2, Math.min(5, item.attempts || 0)));
        inboundSpool.markRetry(item.providerMessageId, {
          nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
          error: outcome.code || outcome.reason || 'NETWORK',
        });
        if (outcome.status === 401 || outcome.status === 403 || outcome.status === 404) break;
      }
    }
  } catch (error) {
    console.error('[v7-reliability] delivery_failed', String(error?.code || 'SPOOL_ERROR'));
  } finally { deliveryBusy = false; }
}

async function reportInboundReceipts() {
  if (receiptBusy || stopping || !S2S_ENABLED || !process.env.DRVOWA_RUNTIME_TOKEN) return;
  const rows = inboundSpool.listRecent(500).filter(row => row.providerMessageId && row.capturedAt);
  if (!rows.length) return;
  receiptBusy = true;
  try {
    const base = String(process.env.DRVOWA_SAAS_BASE_URL || 'http://127.0.0.1:3100').replace(/[/]+$/, '');
    for (let start = 0; start < rows.length; start += 100) {
      const batch = rows.slice(start, start + 100);
      const response = await fetch(base + '/api/runtime/whatsapp/receipts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + process.env.DRVOWA_RUNTIME_TOKEN,
      },
      body: JSON.stringify({
        accountKey: ACCOUNT_KEY,
        records: batch.map(row => ({
          providerMessageId: row.providerMessageId,
          capturedAt: row.capturedAt,
          status: row.deliveryStatus === 'delivered' ? 'DELIVERED'
            : row.deliveryStatus === 'failed' ? 'FAILED' : 'PENDING',
        })),
      }),
      signal: AbortSignal.timeout(8000),
    });
      if (!response.ok) { console.warn('[v7-reliability] receipts_http', response.status); break; }
    }
  } catch (error) {
    console.warn('[v7-reliability] receipts_retry_next_tick', String(error?.name || 'NETWORK'));
  } finally { receiptBusy = false; }
}

async function contactAllowed(key) {
  await historyPrivacy.get();
  return historyPrivacy.contactAllowed(key);
}
function eventContactAllowed(event) {
  return event?.kind === 'label' ? historyPrivacy.metadataAllowed() : historyPrivacy.contactAllowed(event?.contactKey);
}
function mirrorQueue(event) {
  if (!allowsMirrorEvent(event, historyPrivacy.current()) || !eventContactAllowed(event)) return;
  // No AI decisions here. The SaaS /sync endpoint is observational-only.
  // Historical provider IDs are identical to live IDs, avoiding duplicate rows.
  const identity = event.kind === 'message'
    ? `message:${event.providerMessageId}`
    : event.kind === 'chat'
      ? 'chat:' + createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 36)
      : 'label-event:' + randomUUID(); // add -> remove -> add must not be deduped away.
  mirrorSpool.capture({ providerMessageId: identity, payload: event });
}

function localLidToPn(lid) {
  return sock?.signalRepository?.lidMapping?.getPNForLID?.(lid);
}

async function mirrorMessage(msg, historical) {
  if (historical && await historyPrivacy.get() !== 'allow') return;
  const event = await normalizeMirrorMessage(msg, {
    resolveLidPn: localLidToPn,
    ownDigits: ownAccountDigits(),
    historical,
  });
  if (event && await contactAllowed(event.contactKey)) {
    mirrorQueue(event);
    if (['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER'].includes(event.contentType)) {
      mediaChain = mediaChain.then(() => cacheMedia(msg, event)).catch(error => {
        mirrorErrors++;
        console.warn('[v7-sync] media_cache_failed', String(error?.name || 'DOWNLOAD_ERROR'));
      });
    }
  }
}

async function mirrorChat(chat) {
  if (await historyPrivacy.get() !== 'allow') return;
  const event = await normalizeMirrorChat(chat, { resolveLidPn: localLidToPn });
  if (event && await contactAllowed(event.contactKey)) mirrorQueue(event);
}

async function cacheMedia(msg, event) {
  if (!(await contactAllowed(event.contactKey)) || !allowsMirrorEvent(event, historyPrivacy.current())) return;
  if (event.fileSize && event.fileSize > MAX_MEDIA_BYTES) return;
  const id = 'media:' + event.providerMessageId;
  if (mediaSpool.hasProviderMessageId(id)) return;
  const downloaded = await downloadMediaMessage(msg, 'buffer', {}, {
    logger, reuploadRequest: sock?.updateMediaMessage?.bind(sock),
  });
  if (!(await contactAllowed(event.contactKey)) || !allowsMirrorEvent(event, historyPrivacy.current())) return;
  const bytes = Buffer.from(downloaded);
  if (!bytes.length || bytes.length>MAX_MEDIA_BYTES) return;
  const key = createHash('sha256').update(id).digest('hex');
  fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
  const dest = path.join(MEDIA_DIR, key);
  const temp = dest + '.tmp';
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  fs.renameSync(temp, dest);
  mediaSpool.capture({
    providerMessageId: id, payload: {
      filePath: dest, messageId: event.providerMessageId,
      mimeType: String(event.mimeType || 'application/octet-stream').split(';')[0].trim(),
      fileName: event.fileName || '',
      historical: event.historical,
      contactKey: event.contactKey,
    },
  });
  void flushMediaSpool();
}

async function flushMediaSpool() {
  if (mediaBusy || stopping || !S2S_ENABLED || !process.env.DRVOWA_RUNTIME_TOKEN) return;
  mediaBusy = true;
  try {
    const policy = await historyPrivacy.get();
    if (PRIVACY_SPOOL_PURGE_ENABLED) mediaSpool.purgeMatching(row =>
      historyPrivacy.explicitlyBlocked(row.normalizedEvent.payload?.contactKey), row => {
        // Derive the path from the durable ID; never delete a journal-supplied arbitrary path.
        const key = createHash('sha256').update(row.providerMessageId).digest('hex');
        const expected = path.join(MEDIA_DIR, key);
        if (row.normalizedEvent.payload?.filePath !== expected) throw new Error('MEDIA_PATH_MISMATCH');
        fs.rmSync(expected, { force: true });
      });
    const pending = mediaSpool.getPendingForDelivery()
      .filter(row => allowsMediaEvent(row.normalizedEvent.payload, policy) && historyPrivacy.contactAllowed(row.normalizedEvent.payload?.contactKey)).slice(0, 6);
    if (!pending.length) return;
    const base = String(process.env.DRVOWA_SAAS_BASE_URL || 'http://127.0.0.1:3100').replace(/[/]+$/, '');
    for (const row of pending) {
      const m = row.normalizedEvent.payload;
      if (!(await contactAllowed(m.contactKey)) || !allowsMediaEvent(m, historyPrivacy.current())) continue;
      let success = false;
      let code = 'MEDIA_NETWORK';
      try {
        const data = fs.readFileSync(m.filePath);
        const response = await fetch(base + '/api/runtime/whatsapp/media', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + process.env.DRVOWA_RUNTIME_TOKEN,
            'Content-Type': 'application/octet-stream',
            'X-Drvo-Account-Key': ACCOUNT_KEY,
            'X-Drvo-Provider-Message-Id': m.messageId,
            'X-Drvo-Media-Mime': m.mimeType,
            // Filenames with non-ASCII characters remain in the /sync metadata.
            'X-Drvo-Media-Name': /^[\\x20-\\x7e]+$/.test(m.fileName) ? m.fileName : '',
          },
          body: data,
          signal: AbortSignal.timeout(60000),
        });
        success = response.ok;
        code = 'MEDIA_HTTP_' + response.status;
      } catch(error) { code = String(error?.name || 'MEDIA_NETWORK'); }
      if (success) {
        mediaSpool.markDelivered(row.providerMessageId);
        try { fs.unlinkSync(m.filePath); } catch { /* saved remote */ }
      } else {
        const retry = Math.min(180_000, 4000 * (2 ** Math.min(row.attempts || 0, 6)));
        mediaSpool.markRetry(row.providerMessageId, {
          nextRetryAt: new Date(Date.now() + retry).toISOString(), error: code,
        });
      }
    }
  } finally { mediaBusy = false; }
}

async function flushMirrorSpool() {
  if (mirrorBusy || stopping || !S2S_ENABLED || !process.env.DRVOWA_RUNTIME_TOKEN) return;
  mirrorBusy = true;
  try {
    const policy = await historyPrivacy.get();
    if (PRIVACY_SPOOL_PURGE_ENABLED) mirrorSpool.purgeMatching(row =>
      historyPrivacy.explicitlyBlocked(row.normalizedEvent.payload?.contactKey));
    const pending = mirrorSpool.getPendingForDelivery()
      .filter(row => allowsMirrorEvent(row.normalizedEvent.payload, policy) && eventContactAllowed(row.normalizedEvent.payload)).slice(0, 24);
    if (!pending.length) return;
    const base = String(process.env.DRVOWA_SAAS_BASE_URL || 'http://127.0.0.1:3100').replace(/[/]+$/, '');
    for (let i = 0; i < pending.length; i += 6) {
      const batch = pending.slice(i, i + 6).filter(item => allowsMirrorEvent(item.normalizedEvent.payload, historyPrivacy.current()) && eventContactAllowed(item.normalizedEvent.payload));
      if (!batch.length) continue;
      let okay = false;
      let errorCode = 'NETWORK';
      try {
        const response = await fetch(base + '/api/runtime/whatsapp/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + process.env.DRVOWA_RUNTIME_TOKEN,
          },
          body: JSON.stringify({
            accountKey: ACCOUNT_KEY,
            events: batch.map(item => item.normalizedEvent.payload),
          }),
          signal: AbortSignal.timeout(15000),
        });
        okay = response.ok;
        errorCode = 'HTTP_' + response.status;
      } catch (error) { errorCode = String(error?.name || 'NETWORK'); }
      for (const item of batch) {
        if (okay) mirrorSpool.markDelivered(item.providerMessageId);
        else {
          const delay = Math.min(120_000, 2000 * (2 ** Math.min(item.attempts || 0, 6)));
          mirrorSpool.markRetry(item.providerMessageId, {
            nextRetryAt: new Date(Date.now() + delay).toISOString(),
            error: errorCode,
          });
        }
      }
      if (!okay) {
        mirrorErrors++;
        // Invalid payloads remain durable and visible; no silent drop.
        console.warn('[v7-sync] pending_retry', errorCode);
        break;
      }
    }
  } finally { mirrorBusy = false; }
}

function scheduleMirrorMessage(msg, historical) {
  if (historical && historyPrivacy.current() !== 'allow') return;
  historyChain = historyChain.then(() => mirrorMessage(msg, historical)).catch(err => {
    mirrorErrors++;
    console.error('[v7-sync] message_capture_failed', String(err?.name || 'SYNC_ERROR'));
  });
}

function scheduleMirrorChat(chat) {
  if (historyPrivacy.current() !== 'allow') return;
  historyChain = historyChain.then(() => mirrorChat(chat)).catch(err => {
    mirrorErrors++;
    console.error('[v7-sync] chat_capture_failed', String(err?.name || 'SYNC_ERROR'));
  });
}

function scheduleLabelEdit(label) {
  if (historyPrivacy.current() !== 'allow') return;
  // All events go through the same crash-safe delivery spool as mirror history.
  historyChain = historyChain.then(() => {
    const normalized = normalizeLabelEdit(label);
    if (!normalized) { labelEventsSkipped++; return; }
    labelEventsSeen++;
    mirrorQueue(normalized);
  }).catch(err => {
    mirrorErrors++;
    console.warn('[v7-label] capture_failed', String(err?.name || 'SYNC_ERROR'));
  });
}

function scheduleLabelAssociation(payload) {
  if (historyPrivacy.current() !== 'allow') return;
  historyChain = historyChain.then(async () => {
    const normalized = await normalizeLabelAssociation(payload, { resolveLidPn: localLidToPn });
    if (!normalized) { labelEventsSkipped++; return; }
    labelEventsSeen++;
    mirrorQueue(normalized);
  }).catch(err => {
    mirrorErrors++;
    console.warn('[v7-label] capture_failed', String(err?.name || 'SYNC_ERROR'));
  });
}

function onHistorySet(data) {
  if (historyPrivacy.current() !== 'allow') return;
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const chats = Array.isArray(data?.chats) ? data.chats : [];
  const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
  for (const chat of chats) scheduleMirrorChat(chat);
  for (const contact of contacts) scheduleMirrorChat(contact);
  for (const message of messages) scheduleMirrorMessage(message, true);
  console.info('[v7-sync] history_batch', {
    chats: chats.length, contacts: contacts.length, messages: messages.length,
  });
}

function onMessagesUpsert(upsert) {
  const type = upsert?.type || 'unknown';
  const messages = Array.isArray(upsert?.messages) ? upsert.messages : [];
  for (const msg of messages) {
    // Non-notify events never enter the live inbound/outbound paths.
    if (type !== 'notify') {
      scheduleMirrorMessage(msg, true);
      continue;
    }
    const key = msg?.key || {};
    const summary = summarizeInbound(msg);
    summary.upsertType = type;

    const ignore = shouldIgnoreUpsert(msg);
    if (ignore) {
      // Group/broadcasts have individual participants but aren't private chats.
      logInboundSafe(summary, type);
      continue;
    }

    // Outbound observation path (manual phone / API echo) — never inbound ingest.
    if (key.fromMe) {
      summary.decryptOutcome = 'outbound_observation_candidate';
      logInboundSafe(summary, type);
      maybeObserveOutbound(msg).catch(() => {});
      scheduleMirrorMessage(msg, type !== 'notify');
      continue;
    }

    peerCryptoHealth.observe({ key, type, summary });
    const failurePmid = summary.messageId || msg?.key?.id || null;
    // Live media is mirrored as an attachment; live text stays on the
    // transactional /inbound AI scheduling path. Append history NEVER schedules.
    if (type !== 'notify' || msg?.message?.imageMessage || msg?.message?.videoMessage
       || msg?.message?.audioMessage || msg?.message?.documentMessage
       || msg?.message?.stickerMessage) scheduleMirrorMessage(msg, type !== 'notify');
    if (summary.plaintextPresent === 'YES') {
      cryptoHealth.recordPlaintext();
      deliveryEvidence.recordInbound(key, type, true);
      maybeDeliver(msg, type).catch((error) => {
        console.error('[v7-reliability] inbound_capture_failed', String(error?.code || error?.name || 'CAPTURE_ERROR'));
      });
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

  await historyPrivacy.get({ force: true });
  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu('DRVOWA-Baileys-V7'),
    syncFullHistory: historyPrivacy.current() === 'allow',
    shouldSyncHistoryMessage: () => historyPrivacy.current() === 'allow',
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: (key) => pendingRetry.getMessage(key),
  });

  const currentSocket = sock;
  let closed = false;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    if (sock !== currentSocket || stopping || closed) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        await writeQr(qr);
      } catch (err) {
        snapshot.lastErrorCode = 'QR_WRITE_FAILED';
        setState(snapshot.state === 'QR_REQUIRED' ? 'QR_REQUIRED' : 'ERROR');
      }
    }
    if (sock !== currentSocket || stopping || closed) return;
    if (connection === 'open') {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectPolicy.opened();
      snapshot.lastErrorCode = null;
      snapshot.qr = null;
      snapshot.qrAvailable = false;
      snapshot.lastConnectedAt = new Date().toISOString();
      setState('READY');
    } else if (connection === 'connecting') {
      if (snapshot.state !== 'QR_REQUIRED') setState('CONNECTING');
    } else if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;
      closed = true;
      const decision = reconnectPolicy.closed(statusCode);
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
      if (decision.action !== 'RETRY_SCHEDULED') {
        snapshot.lastErrorCode = decision.action;
        setState('ERROR');
        return;
      }
      setState('DISCONNECTED');
      if (!stopping && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (stopping || sock !== currentSocket || snapshot.state !== 'DISCONNECTED') return;
          setState('CONNECTING');
          startSocket().catch(() => {
            if (stopping) return;
            reconnectPolicy.startFailed();
            snapshot.lastErrorCode = 'RECONNECT_FAILED';
            setState('ERROR');
            console.error('[v7-worker] reconnect_failed');
          });
        }, decision.delayMs);
      }
    }
  });
  sock.ev.on('messages.upsert', (update) => {
    if (sock === currentSocket && !stopping && !closed) onMessagesUpsert(update);
  });
  sock.ev.on('messages.update', (updates) => {
    if (sock !== currentSocket || stopping || closed) return;
    let changed = false;
    for (const item of Array.isArray(updates) ? updates : []) {
      if (deliveryEvidence.recordUpdate(item?.key, item?.update?.status)) changed = true;
    }
    if (changed) emitStatus();
  });
  sock.ev.on('messaging-history.set', onHistorySet);
  sock.ev.on('labels.edit', scheduleLabelEdit);
  sock.ev.on('labels.association', scheduleLabelAssociation);
  sock.ev.on('chats.upsert', chats => { for (const chat of chats || []) scheduleMirrorChat(chat); });
  sock.ev.on('chats.update', chats => { for (const chat of chats || []) scheduleMirrorChat(chat); });
  sock.ev.on('contacts.upsert', contacts => { for (const c of contacts || []) scheduleMirrorChat(c); });
  sock.ev.on('contacts.update', contacts => { for (const c of contacts || []) scheduleMirrorChat(c); });
}

function enqueueSend(fn) {
  const run = sendChain.then(fn, fn);
  sendChain = run.then(() => undefined, () => undefined);
  return run;
}

async function handleSend({ phone, message, idempotencyKey }) {
  if (!(await contactAllowed(normalizePhoneDigits(phone)))) {
    return { success: false, status: 'failed', error: 'Privacy policy blocks destination or is unavailable', code: 'PRIVATE_CONTACT_OR_POLICY_UNAVAILABLE', httpStatus: 403 };
  }
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
    const sendingSocket = sock;
    const sendingConnectedAt = snapshot.lastConnectedAt;
    // Check again after waiting in the send queue; no send on a stopped socket.
    if (!sendingSocket || stopping || !snapshot.ready) {
      return { success: false, status: 'failed', code: 'NOT_READY', error: 'Account is not READY', httpStatus: 409 };
    }
    const messageId = generateMessageIDV2(sendingSocket.user?.id);
    const release = pendingRetry.reserve({ id: messageId, remoteJid: jid, fromMe: true });
    let result;
    try {
      result = await sendingSocket.sendMessage(jid, { text }, { messageId });
      if (result?.key?.id && result?.message) retryStore.put(result.key, result.message, jid);
    } finally {
      release();
    }
    if (sock === sendingSocket && snapshot.ready && snapshot.lastConnectedAt === sendingConnectedAt) {
      deliveryEvidence.recordSent(result?.key, jid);
      emitStatus();
    }
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
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectPolicy.stopped();
  if (incidentTimer) { clearInterval(incidentTimer); incidentTimer = null; }
  clearInterval(retrySweepTimer);
  pendingRetry.clear();
  retryStore.clear();
  if (inboundTimer) clearInterval(inboundTimer);
  if (receiptTimer) clearInterval(receiptTimer);
  if (mirrorTimer) clearInterval(mirrorTimer);
  if (mediaTimer) clearInterval(mediaTimer);
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

  inboundTimer = setInterval(() => void flushInboundSpool(), 3000);
  mirrorTimer = setInterval(() => void flushMirrorSpool(), 5000);
  mediaTimer = setInterval(() => void flushMediaSpool(), 5000);
  void flushMediaSpool();
  void flushMirrorSpool();
  receiptTimer = setInterval(() => void reportInboundReceipts(), 30_000);
  void flushInboundSpool();
  void reportInboundReceipts();
  setState('STARTING');
  incidentTimer = setInterval(() => {
    if (stopping) return;
    try {
      incidentMonitor.sample(getStatus());
      emitStatus();
    } catch { console.warn('[v7-reliability-incident] sample_failed'); }
  }, 15_000);
  incidentTimer.unref();
  await startSocket();

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[v7-worker] fatal', String(err?.message || err).slice(0, 200));
  process.exit(1);
});
