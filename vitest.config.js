import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import path from 'path';

// Load the test-specific environment and override any existing process values
// so that the production .env file cannot leak real credentials into tests.
config({ path: '.env.test', override: true });

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = path.resolve('tests/data');
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    exclude: ['tests/_legacy/**', 'node_modules/**'],
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false,
    env: {
      DATA_DIR: process.env.DATA_DIR,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
        statements: 50
      },
      exclude: [
        'node_modules/',
        'tests/',
        'public/',
        '**/*.config.js',
        'launcher.js',
        'bot.js',
        'bot-campaign.js'
      ]
    }
  }
});
