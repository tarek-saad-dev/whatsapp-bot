'use strict';

const { createMemoryDeliveryStore } = require('./memoryDeliveryStore');
const { createSqlDeliveryStore } = require('./sqlDeliveryStore');

let currentStore = null;

function shouldUseMemoryStore() {
    if (process.env.GATEWAY_IDEMPOTENCY_STORE === 'sql') return false;
    if (process.env.GATEWAY_IDEMPOTENCY_STORE === 'memory') return true;
    return process.env.VITEST === 'true';
}

function getDeliveryStore() {
    if (currentStore) return currentStore;
    currentStore = shouldUseMemoryStore()
        ? createMemoryDeliveryStore()
        : createSqlDeliveryStore();
    return currentStore;
}

function setDeliveryStore(store) {
    currentStore = store;
    return currentStore;
}

function useMemoryDeliveryStore() {
    currentStore = createMemoryDeliveryStore();
    return currentStore;
}

function resetDeliveryStore() {
    currentStore = null;
}

module.exports = {
    getDeliveryStore,
    setDeliveryStore,
    useMemoryDeliveryStore,
    resetDeliveryStore,
    createMemoryDeliveryStore,
    createSqlDeliveryStore,
};
