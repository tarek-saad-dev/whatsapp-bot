'use strict';

require('dotenv').config();

const { getTransportMode } = require('./transport/config');

const mode = getTransportMode();

module.exports = mode === 'baileys'
    ? require('./transport/baileysWhatsAppService')
    : require('./transport/seleniumWhatsAppService');

module.exports.getTransportMode = getTransportMode;
