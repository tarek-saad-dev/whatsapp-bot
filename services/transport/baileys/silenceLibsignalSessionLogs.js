'use strict';

/**
 * libsignal logs "Closing session:" / "Session already closed" via console.info/warn
 * and dumps the full SessionEntry (including privKey / chainKey / rootKey).
 * Patch console once to emit only non-secret churn metadata.
 */

let installed = false;
let sessionCloseCount = 0;
let sessionAlreadyClosedCount = 0;

function isLibsignalSessionDump(args) {
    const first = args && args[0];
    if (typeof first !== 'string') return false;
    return first.startsWith('Closing session')
        || first.startsWith('Session already closed');
}

function recordSafeSessionChurn(args, logger) {
    const first = String((args && args[0]) || '');
    if (first.startsWith('Closing session')) {
        sessionCloseCount += 1;
        if (logger && typeof logger.info === 'function') {
            logger.info('[baileys] signal_session_churn', {
                event: 'closing',
                count: sessionCloseCount,
            });
        }
        return true;
    }
    if (first.startsWith('Session already closed')) {
        sessionAlreadyClosedCount += 1;
        if (logger && typeof logger.info === 'function') {
            logger.info('[baileys] signal_session_churn', {
                event: 'already_closed',
                count: sessionAlreadyClosedCount,
            });
        }
        return true;
    }
    return false;
}

function installLibsignalSessionLogSilence({ logger = console } = {}) {
    if (installed) return { alreadyInstalled: true };
    installed = true;

    const original = {
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        log: console.log.bind(console),
        debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
    };

    function replace(method) {
        console[method] = (...args) => {
            if (isLibsignalSessionDump(args)) {
                recordSafeSessionChurn(args, logger);
                return;
            }
            return original[method](...args);
        };
    }

    replace('info');
    replace('warn');
    replace('log');
    replace('debug');

    return { alreadyInstalled: false };
}

function getSessionChurnStats() {
    return {
        sessionCloseCount,
        sessionAlreadyClosedCount,
    };
}

function _resetCountersForTests() {
    sessionCloseCount = 0;
    sessionAlreadyClosedCount = 0;
}

module.exports = {
    installLibsignalSessionLogSilence,
    isLibsignalSessionDump,
    recordSafeSessionChurn,
    getSessionChurnStats,
    _resetCountersForTests,
};
