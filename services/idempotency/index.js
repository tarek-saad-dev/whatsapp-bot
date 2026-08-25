'use strict';

const { STATUSES, CODES, MAX_IDEMPOTENCY_KEY_LENGTH } = require('./constants');
const { computeRequestHash } = require('./requestHash');
const { claimDelivery, recordSendOutcome } = require('./claimDelivery');
const { getDeliveryStore, setDeliveryStore, useMemoryDeliveryStore, resetDeliveryStore } = require('./deliveryStore');
const { sendGenericWithIdempotency } = require('./genericIdempotentSend');

module.exports = {
    STATUSES,
    CODES,
    MAX_IDEMPOTENCY_KEY_LENGTH,
    computeRequestHash,
    claimDelivery,
    recordSendOutcome,
    getDeliveryStore,
    setDeliveryStore,
    useMemoryDeliveryStore,
    resetDeliveryStore,
    sendGenericWithIdempotency,
};
