'use strict';

const express = require('express');
const {
  isMultiAccountEnabled,
  verifyRuntimeBearer,
} = require('../services/drvowa/s2sAuth');
const { validateAccountKey } = require('../services/drvowa/accountKey');
const { getWhatsAppAccountManager } = require('../services/drvowa');

const router = express.Router();

function requireS2S(req, res, next) {
  const auth = verifyRuntimeBearer(req.headers.authorization);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }
  return next();
}

function requireMultiAccount(req, res, next) {
  if (!isMultiAccountEnabled()) {
    return res.status(503).json({
      success: false,
      error: 'DRVOWA multi-account runtime is disabled',
      code: 'MULTI_ACCOUNT_DISABLED',
    });
  }
  return next();
}

function parseAccountKey(req, res) {
  const validated = validateAccountKey(req.params.accountKey);
  if (!validated.ok) {
    res.status(400).json({ success: false, error: validated.error, code: 'INVALID_ACCOUNT_KEY' });
    return null;
  }
  return validated.accountKey;
}

router.use(requireS2S);
router.use(requireMultiAccount);

router.post('/:accountKey/start', async (req, res) => {
  const accountKey = parseAccountKey(req, res);
  if (!accountKey) return;
  try {
    const status = await getWhatsAppAccountManager().start(accountKey);
    return res.status(200).json({ success: true, status });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      error: err.message || 'start_failed',
      code: err.code || 'START_FAILED',
    });
  }
});

router.post('/:accountKey/stop', async (req, res) => {
  const accountKey = parseAccountKey(req, res);
  if (!accountKey) return;
  try {
    const status = await getWhatsAppAccountManager().stop(accountKey);
    return res.status(200).json({ success: true, status });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      error: err.message || 'stop_failed',
      code: err.code || 'STOP_FAILED',
    });
  }
});

router.get('/:accountKey/status', (req, res) => {
  const accountKey = parseAccountKey(req, res);
  if (!accountKey) return;
  try {
    const status = getWhatsAppAccountManager().status(accountKey);
    return res.status(200).json({ success: true, status });
  } catch (err) {
    const statusCode = err.status || 500;
    return res.status(statusCode).json({
      success: false,
      error: err.message || 'status_failed',
      code: err.code || 'STATUS_FAILED',
    });
  }
});

router.get('/:accountKey/qr', (req, res) => {
  const accountKey = parseAccountKey(req, res);
  if (!accountKey) return;
  try {
    const qr = getWhatsAppAccountManager().qr(accountKey);
    return res.status(200).json({ success: true, ...qr });
  } catch (err) {
    const statusCode = err.status || 500;
    return res.status(statusCode).json({
      success: false,
      error: err.message || 'qr_failed',
      code: err.code || 'QR_FAILED',
    });
  }
});

router.post('/:accountKey/send', async (req, res) => {
  const accountKey = parseAccountKey(req, res);
  if (!accountKey) return;
  try {
    const result = await getWhatsAppAccountManager().send(accountKey, req.body || {});
    const httpStatus = result && result.httpStatus
      ? result.httpStatus
      : (result && result.success ? 200 : 409);
    const body = { ...result };
    delete body.httpStatus;
    return res.status(httpStatus).json(body);
  } catch (err) {
    const statusCode = err.status || 500;
    return res.status(statusCode).json({
      success: false,
      error: err.message || 'send_failed',
      code: err.code || 'SEND_FAILED',
    });
  }
});

module.exports = router;
