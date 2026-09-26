'use strict';

const path = require('path');
const fs = require('fs');

const { createBaileysTransport } = require('../transport/baileys/baileysTransport');
const { createInboxSpool } = require('../inbox/inboxSpool');
const { getManagedAuthBaseDir } = require('./s2sAuth');
const { buildDrvowaInboundDto } = require('./inboundDto');
const { CONNECTION_STATES } = require('./connectionStates');
const {
  createDrvowaInboundDeliveryWorker,
} = require('./drvowaInboundDeliveryWorker');
const {
  createOutboundIdempotencyStore,
} = require('./outboundIdempotencyStore');
const {
  createOutboundObservationSpool,
} = require('./outboundObservationSpool');
const {
  createManagedOutboundObserver,
} = require('./managedOutboundObserver');
const {
  createDrvowaOutboundObservationWorker,
} = require('./drvowaOutboundObservationWorker');
const {
  sendManagedWithIdempotency,
} = require('./managedOutboundSend');
const {
  createOutboundNumberSafety,
} = require('./outboundNumberSafety');
const {
  normalizeV6InboundCapture,
  buildCryptoHealthStatus,
} = require('./compatibilityClassifier');

function createNoopDeliveryWorker() {
  return {
    start() {},
    stop() {},
    async tick() {},
    getStatus() {
      return { running: false, mode: 'noop' };
    },
  };
}

/**
 * Thin provider around existing Baileys transport factory.
 * One instance per managed accountKey.
 */
function createBaileysProvider({
  accountKey,
  createTransport = createBaileysTransport,
  authBaseDir = getManagedAuthBaseDir(),
  logger = console,
  onInboundDto = null,
  onLoggedOut = null,
  printQrToTerminal = false,
  createDeliveryWorker = createDrvowaInboundDeliveryWorker,
  fetchImpl = global.fetch,
} = {}) {
  if (!accountKey) {
    throw new Error('accountKey is required');
  }

  const authDir = path.join(authBaseDir, accountKey);
  const lidMapFile = path.join(authDir, 'lid-phone-map.json');
  const spoolFile = path.join(authDir, 'inbox-spool.json');
  const idempotencyFile = path.join(authDir, 'outbound-idempotency.json');
  const outboundObsSpoolFile = path.join(authDir, 'outbound-observation-spool.json');
  fs.mkdirSync(authDir, { recursive: true });

  // Hard invariant: managed auth must never resolve to legacy singleton auth.
  const legacyAuth = path.resolve(process.cwd(), 'data', 'baileys-auth');
  if (path.resolve(authDir) === legacyAuth
    || path.resolve(authDir).startsWith(`${legacyAuth}${path.sep}`)) {
    throw new Error('Managed account authDir must not use legacy baileys-auth path');
  }

  const inboundEvents = [];
  let explicitState = CONNECTION_STATES.STOPPED;
  let lastErrorCode = null;

  const spool = createInboxSpool({
    spoolFile,
  });

  const idempotencyStore = createOutboundIdempotencyStore({
    filePath: idempotencyFile,
  });

  const outboundObservationSpool = createOutboundObservationSpool({
    spoolFile: outboundObsSpoolFile,
  });

  const outboundObservationWorker = createDrvowaOutboundObservationWorker({
    accountKey,
    spool: outboundObservationSpool,
    logger,
    fetchImpl,
  });

  const outboundObservedPoster = createManagedOutboundObserver({
    accountKey,
    idempotencyStore,
    observationSpool: outboundObservationSpool,
    observationWorker: outboundObservationWorker,
    logger,
  });

  // One safety instance per provider lifecycle — counters survive across sends.
  const numberSafety = createOutboundNumberSafety({ accountKey });

  const deliveryWorker = createDeliveryWorker({
    accountKey,
    spool,
    logger,
    fetchImpl,
  });

  const transport = createTransport({
    authDir,
    lidMapFile,
    spool,
    deliveryWorker,
    outboundObservedPoster,
    logger,
    printQrToTerminal,
    onLoggedOut: () => {
      explicitState = CONNECTION_STATES.LOGGED_OUT;
      lastErrorCode = 'LOGGED_OUT';
      if (typeof onLoggedOut === 'function') {
        onLoggedOut({ accountKey });
      }
    },
    onLiveInbound: (event) => {
      const dto = buildDrvowaInboundDto({
        accountKey,
        providerMessageId: event.providerMessageId,
        externalContactKey: event.externalContactKey,
        fromMe: event.fromMe,
        isGroup: event.isGroup,
        messageTimestamp: event.messageTimestamp,
        receivedAt: event.receivedAt,
        upsertType: event.upsertType,
        content: event.content,
      });

      if (event.providerMessageId && typeof spool.attachDrvowaPayload === 'function') {
        spool.attachDrvowaPayload(event.providerMessageId, dto);
      }

      logger.info('[drvowa-inbound] captured', {
        accountKey,
        providerMessageId: event.providerMessageId || null,
      });

      inboundEvents.push(dto);
      if (inboundEvents.length > 200) inboundEvents.shift();
      if (typeof onInboundDto === 'function') {
        onInboundDto(dto);
      }
    },
  });

  function deriveState() {
    if (explicitState === CONNECTION_STATES.STARTING
      || explicitState === CONNECTION_STATES.STOPPING) {
      return explicitState;
    }
    const status = transport.getStatus();
    if (status.loggedOut) return CONNECTION_STATES.LOGGED_OUT;
    if (status.ready) return CONNECTION_STATES.READY;
    if (status.qrRequired || status.qrAvailable) return CONNECTION_STATES.QR_REQUIRED;
    if (explicitState === CONNECTION_STATES.ERROR) return CONNECTION_STATES.ERROR;
    if (status.lastDisconnectAt && !status.ready) return CONNECTION_STATES.DISCONNECTED;
    if (explicitState === CONNECTION_STATES.CONNECTING) return CONNECTION_STATES.CONNECTING;
    return explicitState === CONNECTION_STATES.STOPPED
      ? CONNECTION_STATES.STOPPED
      : CONNECTION_STATES.CONNECTING;
  }

  async function start() {
    if (transport.getStatus().loggedOut) {
      explicitState = CONNECTION_STATES.LOGGED_OUT;
      return getStatus();
    }
    explicitState = CONNECTION_STATES.STARTING;
    try {
      explicitState = CONNECTION_STATES.CONNECTING;
      await transport.start();
      outboundObservationWorker.start();
      explicitState = deriveState();
      return getStatus();
    } catch (err) {
      explicitState = CONNECTION_STATES.ERROR;
      lastErrorCode = 'START_FAILED';
      throw err;
    }
  }

  async function stop() {
    explicitState = CONNECTION_STATES.STOPPING;
    outboundObservationWorker.stop();
    await transport.stop();
    explicitState = CONNECTION_STATES.STOPPED;
    return getStatus();
  }

  async function send(phone, message, { idempotencyKey } = {}) {
    const state = deriveState();
    if (state === CONNECTION_STATES.LOGGED_OUT) {
      return {
        success: false,
        status: 'failed',
        error: 'Account is logged out',
        code: 'LOGGED_OUT',
        idempotencyKey: idempotencyKey || undefined,
      };
    }
    if (state !== CONNECTION_STATES.READY) {
      return {
        success: false,
        status: 'failed',
        error: `Account is not READY (state=${state})`,
        code: 'NOT_READY',
        idempotencyKey: idempotencyKey || undefined,
      };
    }
    return sendManagedWithIdempotency({
      accountKey,
      phone,
      message,
      idempotencyKey,
      store: idempotencyStore,
      sendFn: (p, m) => transport.send(p, m),
      // Fail-safe: queue DRVOWA_API observation from the managed send path.
      // Baileys does not reliably echo same-socket sends via messages.upsert/fromMe.
      observeApiOutbound: (payload) => outboundObservedPoster.observe(payload),
      numberSafety,
      logger,
    });
  }

  function getStatus() {
    const transportStatus = transport.getStatus();
    const state = deriveState();
    const delivery = deliveryWorker.getStatus();
    const outboundObs = outboundObservationWorker.getStatus();
    return {
      accountKey,
      provider: 'baileys',
      state,
      ready: state === CONNECTION_STATES.READY,
      qrAvailable: Boolean(transport.getQr && transport.getQr()),
      lastConnectedAt: transportStatus.lastConnectedAt || null,
      lastDisconnectAt: transportStatus.lastDisconnectAt || null,
      lastDisconnectCode: transportStatus.lastDisconnectCode != null
        ? transportStatus.lastDisconnectCode
        : null,
      lastErrorCode: lastErrorCode
        || (transportStatus.loggedOut ? 'LOGGED_OUT' : null)
        || delivery.lastErrorCode
        || null,
      reconnectAttempts: transportStatus.reconnectAttempts || 0,
      authDir,
      inboundDelivery: {
        running: Boolean(delivery.running),
        pending: delivery.pending ?? 0,
        delivered: delivery.delivered ?? 0,
        failed: delivery.failed ?? 0,
        quarantined: delivery.quarantined ?? 0,
        inFlight: Boolean(delivery.inFlight),
        lastDeliveryAt: delivery.lastDeliveryAt || null,
        lastErrorCode: delivery.lastErrorCode || null,
      },
      inboundCapture: (() => {
        const inbox = transportStatus.inbox || null;
        const capture = inbox && inbox.inboundCapture ? inbox.inboundCapture : null;
        return {
          rawUpsert: capture?.rawUpsert ?? 0,
          captured: capture?.captured ?? inbox?.lastCapturedCount ?? 0,
          unresolvedLid: capture?.unresolvedLid
            ?? transportStatus.unresolvedLidCount
            ?? 0,
          decryptFailed: capture?.decryptFailed ?? 0,
          emptyContent: capture?.emptyContent ?? 0,
          quarantined: capture?.quarantined ?? 0,
          pendingLid: capture?.pendingLid ?? 0,
          pendingDecrypt: capture?.pendingDecrypt ?? 0,
          durableQuarantine: capture?.durableQuarantine ?? 0,
          listening: Boolean(inbox?.listening),
          lastEventAt: inbox?.lastPollAt || null,
          lastPlaintextInboundAt: capture?.lastPlaintextInboundAt || null,
          lastDecryptFailureAt: capture?.lastDecryptFailureAt || null,
          distinctDecryptFailureMessageIds:
            capture?.distinctDecryptFailureMessageIds ?? 0,
          messageAbsentFromNodeCount: capture?.messageAbsentFromNodeCount ?? 0,
          activeFailureStreak: capture?.activeFailureStreak ?? 0,
          activeFailureDistinctIds: capture?.activeFailureDistinctIds ?? 0,
          failureEpisodeStartedAt: capture?.failureEpisodeStartedAt || null,
        };
      })(),
      cryptoHealth: (() => {
        const inbox = transportStatus.inbox || null;
        const capture = inbox && inbox.inboundCapture ? inbox.inboundCapture : null;
        const normalized = normalizeV6InboundCapture({
          captured: capture?.captured ?? inbox?.lastCapturedCount ?? 0,
          decryptFailed: capture?.decryptFailed ?? 0,
          lastEventAt: inbox?.lastPollAt || null,
          lastPlaintextInboundAt: capture?.lastPlaintextInboundAt || null,
          lastDecryptFailureAt: capture?.lastDecryptFailureAt || null,
          distinctDecryptFailureMessageIds:
            capture?.distinctDecryptFailureMessageIds ?? 0,
          messageAbsentFromNodeCount: capture?.messageAbsentFromNodeCount ?? 0,
          activeFailureStreak: capture?.activeFailureStreak ?? 0,
          activeFailureDistinctIds: capture?.activeFailureDistinctIds ?? 0,
          failureEpisodeStartedAt: capture?.failureEpisodeStartedAt || null,
        });
        return buildCryptoHealthStatus(normalized, {
          socketReady: state === CONNECTION_STATES.READY,
        });
      })(),
      signalSessionChurn: transportStatus.diagnostics?.signalSessionChurn || null,
      outboundObservation: {
        running: Boolean(outboundObs.running),
        deliveryEnabled: Boolean(outboundObs.deliveryEnabled),
        pending: outboundObs.pending ?? 0,
        unresolved: outboundObs.unresolved ?? 0,
        failed: outboundObs.failed ?? 0,
        delivered: outboundObs.delivered ?? 0,
        oldestUnresolvedCapturedAt: outboundObs.oldestUnresolvedCapturedAt || null,
        unresolvedSaturated: Boolean(outboundObs.unresolvedSaturated),
        fetchAttempts: outboundObs.fetchAttempts ?? 0,
        lastErrorCode: outboundObs.lastErrorCode || null,
      },
      idempotency: (() => {
        const s = typeof idempotencyStore.getStats === 'function'
          ? idempotencyStore.getStats()
          : { total: idempotencyStore.size(), sending: 0, sent: 0, saturated: false };
        return {
          total: s.total ?? 0,
          sending: s.sending ?? 0,
          sent: s.sent ?? 0,
          saturated: Boolean(s.saturated),
        };
      })(),
      numberSafety: (() => {
        const s = numberSafety.getStatus();
        return {
          state: s.state,
          cooldownUntil: s.cooldownUntil,
          minuteCount: s.minuteCount,
          hourCount: s.hourCount,
          dayCount: s.dayCount,
        };
      })(),
    };
  }

  function getQr() {
    if (typeof transport.getQr !== 'function') return null;
    return transport.getQr();
  }

  function getInboundEvents() {
    return inboundEvents.slice();
  }

  return {
    accountKey,
    authDir,
    start,
    stop,
    send,
    getStatus,
    getQr,
    getInboundEvents,
    _transport: transport,
    _spool: spool,
    _deliveryWorker: deliveryWorker,
    _idempotencyStore: idempotencyStore,
    _outboundObservationSpool: outboundObservationSpool,
    _outboundObservationWorker: outboundObservationWorker,
  };
}

module.exports = {
  createBaileysProvider,
  createNoopDeliveryWorker,
};
