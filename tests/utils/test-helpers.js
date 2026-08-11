import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TEST_DATA_DIR = path.resolve(process.env.DATA_DIR || 'tests/data');

export function resetTestData() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

export function readDataFile(fileName) {
  const filePath = path.join(TEST_DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeDataFile(fileName, data) {
  const filePath = path.join(TEST_DATA_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function loadFixture(name) {
  const filePath = path.join(import.meta.dirname, '..', 'fixtures', `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
