import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = path.resolve(process.env.DATA_DIR || 'tests/data');

function cleanTestData() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

// Clean the isolated test data directory before each test file is loaded.
// This guarantees that the production data/ directory is never touched by tests.
cleanTestData();

// Also reset the directory after all tests in the file have finished.
// Vitest setupFiles run in the same context as the test file, so the
// afterAll hook is registered for each test file that imports this setup.
import { afterAll } from 'vitest';
afterAll(() => {
  cleanTestData();
});
