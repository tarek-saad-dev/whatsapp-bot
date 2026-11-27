import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIncidentStore } from '../src/incidentStore.js';
import { createIncidentMonitor } from '../src/incidentMonitor.js';
const bad = { state: 'ERROR', socketRecovery: { action: 'OPERATOR_REVIEW' } };
test('incident history survives restart and interrupted observation is not recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-'));
  try {
    const store = createIncidentStore(path.join(dir, 'incident.json')); let t = 1000;
    const first = createIncidentMonitor({ ...store, now: () => t });
    first.sample(bad); t = 16000; first.sample(bad);
    t = 31000;
    const second = createIncidentMonitor({ ...store, now: () => t });
    second.sample({ state: 'STARTING' });
    assert.equal(second.snapshot().recent[0].outcome, 'OBSERVATION_INTERRUPTED');
    assert.equal(second.snapshot().recent[0].durationMs, 15000);
    assert.equal(second.snapshot().active.length, 0);
    assert.equal(store.load().recent.length, 1);
    second.sample(bad); t = 46000; second.sample({ state: 'READY' });
    assert.equal(store.load().recent[1].outcome, 'CONDITION_NO_LONGER_OBSERVED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('write errors retry; read error does not overwrite', () => {
  let writes = 0;
  const m = createIncidentMonitor({ save() { if (++writes === 1) throw Error('disk'); } });
  m.sample(bad); assert.equal(m.snapshot().persistence, 'WRITE_ERROR');
  m.sample(bad); assert.equal(m.snapshot().persistence, 'OK');
  const n = createIncidentMonitor({ load() { throw Error('corrupt'); }, save() { writes++; } });
  n.sample(bad); assert.equal(n.snapshot().persistence, 'READ_ERROR'); assert.equal(writes, 2);
});
