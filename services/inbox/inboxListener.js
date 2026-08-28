'use strict';

const { createWhatsAppInboxAdapter } = require('./whatsappInboxAdapter');
const { createInboxSpool } = require('./inboxSpool');
const { createInboxDeliveryWorker } = require('./inboxDeliveryWorker');
const { logInbox } = require('./inboxLogger');
const { utcNow } = require('./inboxTiming');
const {
    getInboxTriggerStatus,
    installInboxTrigger,
    installOpenChatMessageObserver,
    getOpenChatObserverStatus,
} = require('./pageScripts');

const DEFAULT_IDLE_POLL_MS = Number(
    process.env.WHATSAPP_INBOX_DRAIN_MS || process.env.WHATSAPP_INBOX_POLL_MS || 1500,
);
const DEFAULT_ACTIVE_POLL_MS = Number(process.env.WHATSAPP_INBOX_ACTIVE_DRAIN_MS || 500);

function createInboxListener({
    getDriver,
    getOrCreateDriver,
    switchToWhatsAppTab,
    isReady,
    sendQueue,
    idlePollMs = DEFAULT_IDLE_POLL_MS,
    activePollMs = DEFAULT_ACTIVE_POLL_MS,
    spool = createInboxSpool(),
    deliveryWorker = null,
} = {}) {
    const adapter = createWhatsAppInboxAdapter({
        getDriver,
        switchToWhatsAppTab,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        hasProviderMessageId: (id) => spool.hasProviderMessageId(id),
    });

    const worker = deliveryWorker || createInboxDeliveryWorker({ spool });

    let listening = false;
    let pollTimer = null;
    let pollInFlight = false;
    let triggerInstalled = false;
    let openChatObserverInstalled = false;
    let openChatObserverAttached = false;
    let lastPollAt = null;
    let lastError = null;
    let lastCapturedCount = 0;
    let driverInitInFlight = false;

    function schedulePoll(delayMs) {
        if (!listening) return;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(() => {
            tick().catch((error) => {
                lastError = error.message || String(error);
            });
        }, delayMs);
        if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
    }

    async function ensureObservers(drv) {
        if (!drv) return false;

        if (!triggerInstalled) {
            const status = await drv.executeScript(installInboxTrigger);
            triggerInstalled = Boolean(status && status.installed);
            if (triggerInstalled) {
                logInbox('trigger_installed', { trackedChats: status.trackedChats || 0 });
            }
        }

        if (!openChatObserverInstalled) {
            const openStatus = await drv.executeScript(installOpenChatMessageObserver);
            openChatObserverInstalled = Boolean(openStatus && openStatus.installed);
            openChatObserverAttached = Boolean(openStatus && openStatus.attached);
            if (openChatObserverInstalled) {
                logInbox('open_chat_observer_installed', { attached: openChatObserverAttached });
            }
        } else {
            const openStatus = await drv.executeScript(getOpenChatObserverStatus);
            openChatObserverInstalled = Boolean(openStatus && openStatus.installed);
            openChatObserverAttached = Boolean(openStatus && openStatus.attached);
        }

        return triggerInstalled;
    }

    async function ensureDriverForPoll() {
        let drv = getDriver && getDriver();
        if (drv) return drv;
        if (!getOrCreateDriver || driverInitInFlight) return null;

        driverInitInFlight = true;
        try {
            await getOrCreateDriver();
            drv = getDriver && getDriver();
            if (drv) {
                if (switchToWhatsAppTab) await switchToWhatsAppTab();
                await ensureObservers(drv);
            }
            return drv;
        } catch (error) {
            lastError = error.message || String(error);
            logInbox('driver_init_failed', { error: lastError });
            return null;
        } finally {
            driverInitInFlight = false;
        }
    }

    async function pollOnce() {
        const drv = await ensureDriverForPoll();
        if (!drv) return [];

        const ready = isReady ? await isReady() : true;
        if (!ready) return [];

        await ensureObservers(drv);

        const waDetectedAt = utcNow();
        const captureStartedAt = utcNow();

        const runPoll = async () => adapter.poll({ waDetectedAt, captureStartedAt });

        let bundles = [];
        if (sendQueue && sendQueue.enqueue) {
            bundles = await sendQueue.enqueue(runPoll);
        } else {
            bundles = await runPoll();
        }

        const queueTiming = sendQueue && sendQueue.getTimingStats
            ? sendQueue.getTimingStats()
            : { browserQueueWaitMs: 0, browserOperationMs: 0 };

        const persisted = [];
        for (const bundle of bundles) {
            const event = bundle.event || bundle;
            const timing = bundle.timing || null;
            if (!event || !event.providerMessageId) continue;
            if (spool.hasProviderMessageId(event.providerMessageId)) continue;

            if (timing) {
                timing.browserQueueWaitMs = queueTiming.browserQueueWaitMs;
                timing.browserOperationMs = queueTiming.browserOperationMs;
            }

            spool.capture(event, { timing });
            persisted.push(event);

            logInbox('locally_queued', {
                providerMessageId: event.providerMessageId,
                idSource: event.idSource,
                browserQueueWaitMs: timing && timing.browserQueueWaitMs,
                browserOperationMs: timing && timing.browserOperationMs,
                captureLatencyMs: timing && timing.captureLatencyMs,
            });
        }

        lastCapturedCount = persisted.length;
        lastPollAt = utcNow();
        lastError = null;
        return persisted;
    }

    async function tick() {
        if (!listening || pollInFlight) {
            schedulePoll(idlePollMs);
            return 0;
        }

        pollInFlight = true;
        let capturedCount = 0;
        try {
            const stats = sendQueue && sendQueue.getStats
                ? sendQueue.getStats()
                : { active: 0, queued: 0 };

            if (stats.active > 0 || stats.queued > 0) {
                schedulePoll(activePollMs);
                return 0;
            }

            const captured = await pollOnce();
            capturedCount = captured.length;
            await worker.tick();
        } catch (error) {
            lastError = error.message || String(error);
            logInbox('listener_poll_failed', { error: lastError });
        } finally {
            pollInFlight = false;
        }

        const deliveryStats = spool.getStats();
        const nextDelay = (
            capturedCount > 0
            || deliveryStats.pending > 0
            || openChatObserverAttached
        )
            ? activePollMs
            : idlePollMs;
        schedulePoll(nextDelay);
        return capturedCount;
    }

    async function initDriverInBackground() {
        await ensureDriverForPoll();
    }

    function start({ initDriver = false } = {}) {
        if (listening) {
            if (initDriver) initDriverInBackground();
            worker.start();
            return getStatus();
        }

        listening = true;
        worker.start();
        if (initDriver) initDriverInBackground();

        logInbox('listener_started', {
            idlePollMs,
            activePollMs,
            mode: 'phase1.1',
        });
        schedulePoll(0);
        return getStatus();
    }

    function stop() {
        listening = false;
        worker.stop();
        if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
        return getStatus();
    }

    function getInbox(limit) {
        return {
            ...getStatus(),
            messages: spool.listRecent(Number(limit) || 50),
        };
    }

    function getStatus() {
        const adapterStatus = adapter.getStatus();
        const deliveryStats = spool.getStats();
        return {
            listening,
            mode: 'phase1.1',
            triggerInstalled,
            openChatObserverInstalled,
            openChatObserverAttached,
            lastPollAt: lastPollAt || adapterStatus.lastPollAt,
            lastError: lastError || adapterStatus.lastError,
            lastCapturedCount,
            idlePollMs,
            activePollMs,
            pollIntervalMs: idlePollMs,
            browserQueueWaitMs: adapterStatus.browserQueueWaitMs,
            browserOperationMs: adapterStatus.browserOperationMs,
            delivery: deliveryStats,
            deliveryWorker: worker.getStatus(),
            count: deliveryStats.pending + deliveryStats.delivered + deliveryStats.failedOrRetrying,
        };
    }

    function reset() {
        spool.load();
        triggerInstalled = false;
        openChatObserverInstalled = false;
        lastPollAt = null;
        lastError = null;
        lastCapturedCount = 0;
    }

    return {
        start,
        stop,
        tick,
        pollOnce,
        drainOnce: pollOnce,
        getInbox,
        getStatus,
        reset,
        ensureDriverForPoll,
        adapter,
        spool,
        deliveryWorker: worker,
    };
}

module.exports = {
    createInboxListener,
};
