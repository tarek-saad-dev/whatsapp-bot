'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  COMPATIBILITY,
  DEGRADED_MIN_FAILURES,
  DEGRADED_MIN_DISTINCT_IDS,
  EPISODE_MAX_AGE_MS,
  classifyCompatibility,
  recommendRuntimeEngine,
  attachCompatibilityDiagnostics,
} = require('../../services/drvowa/compatibilityClassifier');

const NOW = Date.parse('2026-09-26T00:00:00.000Z');

describe('compatibilityClassifier episode semantics', () => {
  it('CASE A: 0 evidence → UNKNOWN', () => {
    expect(
      classifyCompatibility({
        plaintextInboundCount: 0,
        decryptFailureCount: 0,
        socketReady: true,
        nowMs: NOW,
      }).status,
    ).toBe(COMPATIBILITY.UNKNOWN);
  });

  it('CASE B: 1 plaintext → HEALTHY', () => {
    expect(
      classifyCompatibility({
        plaintextInboundCount: 1,
        decryptFailureCount: 0,
        activeFailureStreak: 0,
        socketReady: true,
        nowMs: NOW,
        lastPlaintextInboundAt: new Date(NOW).toISOString(),
      }).status,
    ).toBe(COMPATIBILITY.HEALTHY);
  });

  it('CASE C: 1 decrypt failure, no plaintext → SUSPECT', () => {
    expect(
      classifyCompatibility({
        plaintextInboundCount: 0,
        decryptFailureCount: 1,
        activeFailureStreak: 1,
        activeFailureDistinctIds: 1,
        failureEpisodeStartedAt: new Date(NOW - 60_000).toISOString(),
        lastDecryptFailureAt: new Date(NOW - 60_000).toISOString(),
        socketReady: true,
        nowMs: NOW,
      }).status,
    ).toBe(COMPATIBILITY.SUSPECT);
  });

  it('CASE D: 3 failures / 2 IDs / recent episode / no recovery / READY → DEGRADED + recommend V7', () => {
    expect(DEGRADED_MIN_FAILURES).toBe(3);
    expect(DEGRADED_MIN_DISTINCT_IDS).toBe(2);
    const r = classifyCompatibility({
      plaintextInboundCount: 0,
      decryptFailureCount: 3,
      activeFailureStreak: 3,
      activeFailureDistinctIds: 2,
      failureEpisodeStartedAt: new Date(NOW - 120_000).toISOString(),
      lastDecryptFailureAt: new Date(NOW - 30_000).toISOString(),
      socketReady: true,
      nowMs: NOW,
    });
    expect(r.status).toBe(COMPATIBILITY.DEGRADED_CRYPTO);
    expect(
      recommendRuntimeEngine({
        compatibilityStatus: r.status,
        runtimeEngine: 'BAILEYS_V6',
      }),
    ).toBe('BAILEYS_V7');
  });

  it('CASE E: historical failures then plaintext → HEALTHY (not DEGRADED)', () => {
    expect(
      classifyCompatibility({
        plaintextInboundCount: 5,
        decryptFailureCount: 3,
        activeFailureStreak: 0,
        activeFailureDistinctIds: 0,
        lastDecryptFailureAt: new Date(NOW - 600_000).toISOString(),
        lastPlaintextInboundAt: new Date(NOW - 10_000).toISOString(),
        socketReady: true,
        nowMs: NOW,
      }).status,
    ).toBe(COMPATIBILITY.HEALTHY);
  });

  it('CASE F: 100 plaintext, transient failure, then plaintext → HEALTHY', () => {
    expect(
      classifyCompatibility({
        plaintextInboundCount: 101,
        decryptFailureCount: 1,
        activeFailureStreak: 0,
        activeFailureDistinctIds: 0,
        lastDecryptFailureAt: new Date(NOW - 50_000).toISOString(),
        lastPlaintextInboundAt: new Date(NOW - 5_000).toISOString(),
        socketReady: true,
        nowMs: NOW,
      }).status,
    ).toBe(COMPATIBILITY.HEALTHY);
  });

  it('CASE G: stale episode beyond window → NOT DEGRADED', () => {
    expect(EPISODE_MAX_AGE_MS).toBeGreaterThan(0);
    expect(
      classifyCompatibility({
        plaintextInboundCount: 0,
        decryptFailureCount: 10,
        activeFailureStreak: 5,
        activeFailureDistinctIds: 4,
        failureEpisodeStartedAt: new Date(NOW - EPISODE_MAX_AGE_MS - 60_000).toISOString(),
        lastDecryptFailureAt: new Date(NOW - EPISODE_MAX_AGE_MS - 30_000).toISOString(),
        socketReady: true,
        nowMs: NOW,
      }).status,
    ).not.toBe(COMPATIBILITY.DEGRADED_CRYPTO);
  });

  it('CASE H: socket not READY → never DEGRADED from crypto alone', () => {
    expect(
      classifyCompatibility({
        plaintextInboundCount: 0,
        decryptFailureCount: 5,
        activeFailureStreak: 5,
        activeFailureDistinctIds: 3,
        failureEpisodeStartedAt: new Date(NOW - 60_000).toISOString(),
        lastDecryptFailureAt: new Date(NOW - 10_000).toISOString(),
        socketReady: false,
        nowMs: NOW,
      }).status,
    ).toBe(COMPATIBILITY.SUSPECT);
  });

  it('lifetime counters alone never degrade without active episode', () => {
    expect(
      classifyCompatibility({
        plaintextInboundCount: 50,
        decryptFailureCount: 99,
        socketReady: true,
        nowMs: NOW,
        lastPlaintextInboundAt: new Date(NOW).toISOString(),
      }).status,
    ).toBe(COMPATIBILITY.HEALTHY);
  });

  it('attachCompatibilityDiagnostics never mutates runtimeEngine', () => {
    const out = attachCompatibilityDiagnostics({
      runtimeEngine: 'BAILEYS_V6',
      ready: true,
      state: 'READY',
      cryptoHealth: {
        plaintextInboundCount: 0,
        decryptFailureCount: 3,
        messageAbsentFromNodeCount: 0,
        activeFailureStreak: 3,
        activeFailureDistinctIds: 2,
        failureEpisodeStartedAt: new Date(NOW - 60_000).toISOString(),
        lastDecryptFailureAt: new Date(NOW - 10_000).toISOString(),
      },
    }, { nowMs: NOW });
    expect(out.runtimeEngine).toBe('BAILEYS_V6');
    expect(out.compatibilityStatus).toBe(COMPATIBILITY.DEGRADED_CRYPTO);
    expect(out.recommendedRuntimeEngine).toBe('BAILEYS_V7');
  });
});
