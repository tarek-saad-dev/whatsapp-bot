'use strict';

const path = require('path');
const fs = require('fs');

const { createBaileysTransport } = require('../transport/baileys/baileysTransport');
const { createInboxSpool } = require('../inbox/inboxSpool');
const { getManagedAuthBaseDir } = require('./s2sAuth');
const { buildDrvowaInboundDto } = require('./inboundDto');
const { CONNECTION_STATES } = require('./connectionStates');

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
} = {}) {
  if (!accountKey) {
    throw new Error('accountKey is required');
  }

  const authDir = path.join(authBaseDir, accountKey);
  const lidMapFile = path.join(authDir, 'lid-phone-map.json');
  const spoolFile = path.join(authDir, 'inbox-spool.json');
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

  const transport = createTransport({
    authDir,
    lidMapFile,
    spool,
    deliveryWorker: createNoopDeliveryWorker(),
    outboundObservedPoster: {
      async observe() {
        return { skipped: true };
      },
    },
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
    await transport.stop();
    explicitState = CONNECTION_STATES.STOPPED;
    return getStatus();
  }

  async function send(phone, message) {
    const state = deriveState();
    if (state === CONNECTION_STATES.LOGGED_OUT) {
      return {
        success: false,
        status: 'failed',
        error: 'Account is logged out',
        code: 'LOGGED_OUT',
      };
    }
    if (state !== CONNECTION_STATES.READY) {
      return {
        success: false,
        status: 'failed',
        error: `Account is not READY (state=${state})`,
        code: 'NOT_READY',
      };
    }
    return transport.send(phone, message);
  }

  function getStatus() {
    const transportStatus = transport.getStatus();
    const state = deriveState();
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
        || (transportStatus.loggedOut ? 'LOGGED_OUT' : null),
      reconnectAttempts: transportStatus.reconnectAttempts || 0,
      authDir,
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
  };
}

module.exports = {
  createBaileysProvider,
  createNoopDeliveryWorker,
};
