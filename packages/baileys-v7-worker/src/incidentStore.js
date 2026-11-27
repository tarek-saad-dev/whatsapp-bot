import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeAtomicFile } = require('../../../services/drvowa/atomicWrite.js');
// Only the per-account worker owns this path, in its private auth directory.
// Bounded metadata only, no message/peer IDs, secrets or bodies.
export function createIncidentStore(file) {
  return {
    load() {
      let data;
      try {
        if (fs.statSync(file).size > 128 * 1024) throw new Error('INCIDENT_FILE_TOO_LARGE');
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      if (data?.version !== 1 || !Array.isArray(data.active) || !Array.isArray(data.recent)) throw new Error('INCIDENT_FILE_INVALID');
      return data;
    },
    save(data) { writeAtomicFile(file, JSON.stringify(data)); },
  };
}
