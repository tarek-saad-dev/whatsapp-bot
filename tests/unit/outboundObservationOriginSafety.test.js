'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createOutboundObservationSpool,
  STATUS,
  ORIGIN,
  normalizeOrigin,
} = require('../../services/drvowa/outboundObservationSpool');

describe('outbound observation origin safety', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvowa-origin-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('normalizeOrigin: only exact known origins; unknown → UNRESOLVED', () => {
    expect(normalizeOrigin(ORIGIN.DRVOWA_API)).toBe(ORIGIN.DRVOWA_API);
    expect(normalizeOrigin(ORIGIN.HUMAN_MANUAL)).toBe(ORIGIN.HUMAN_MANUAL);
    expect(normalizeOrigin(ORIGIN.UNRESOLVED)).toBe(ORIGIN.UNRESOLVED);
    expect(normalizeOrigin(undefined)).toBe(ORIGIN.UNRESOLVED);
    expect(normalizeOrigin(null)).toBe(ORIGIN.UNRESOLVED);
    expect(normalizeOrigin('')).toBe(ORIGIN.UNRESOLVED);
    expect(normalizeOrigin('human')).toBe(ORIGIN.UNRESOLVED);
    expect(normalizeOrigin('HUMAN')).toBe(ORIGIN.UNRESOLVED);
    expect(normalizeOrigin('unknown')).toBe(ORIGIN.UNRESOLVED);
  });

  it('undefined / invalid / empty origin never becomes HUMAN_MANUAL or delivery-eligible', () => {
    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'spool.json'),
    });

    for (const [id, origin] of [
      ['U-undef', undefined],
      ['U-invalid', 'not-a-real-origin'],
      ['U-empty', ''],
    ]) {
      const { record } = spool.captureOrPromote({
        accountKey: 'wa_a',
        providerMessageId: id,
        origin,
        phone: '201555111111',
        occurredAt: new Date().toISOString(),
      });
      expect(record.origin).toBe(ORIGIN.UNRESOLVED);
      expect(record.origin).not.toBe(ORIGIN.HUMAN_MANUAL);
      expect(record.status).toBe(STATUS.UNRESOLVED);
    }

    expect(spool.getPendingForDelivery()).toHaveLength(0);
    expect(spool.getStats().unresolved).toBe(3);
  });

  it('explicit HUMAN_MANUAL still delivery-eligible', () => {
    const spool = createOutboundObservationSpool({
      spoolFile: path.join(tmpDir, 'spool.json'),
    });
    spool.captureOrPromote({
      accountKey: 'wa_a',
      providerMessageId: 'H1',
      origin: ORIGIN.HUMAN_MANUAL,
      phone: '201555111111',
      occurredAt: new Date().toISOString(),
    });
    expect(spool.get('H1').origin).toBe(ORIGIN.HUMAN_MANUAL);
    expect(spool.getPendingForDelivery()).toHaveLength(1);
  });
});
