'use strict';

const { createMemoryDeliveryStore } = require('./memoryDeliveryStore');
const { createSqlDeliveryStore } = require('./sqlDeliveryStore');

let currentStore = null;

function isDatabaseConfigured() {
    const server = String(process.env.DB_SERVER || '').trim();
    if (!server) return false;
    // Local .env.example placeholders must not force a broken SQL ledger.
    if (/^YOUR[_-]/i.test(server)) return false;
    if (server.toLowerCase() === 'your_pc_name_or_ip') return false;
    return true;
}

function shouldUseMemoryStore() {
    if (process.env.GATEWAY_IDEMPOTENCY_STORE === 'sql') return false;
    if (process.env.GATEWAY_IDEMPOTENCY_STORE === 'memory') return true;
    if (process.env.VITEST === 'true') return true;
    // Without a usable DB, Cashier idempotent sends must still reach Baileys/Selenium.
    if (!isDatabaseConfigured()) return true;
    return false;
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
    shouldUseMemoryStore,
    isDatabaseConfigured,
};
