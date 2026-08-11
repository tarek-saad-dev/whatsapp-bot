import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Load the test-specific environment and override any existing process values
// so that the production .env file cannot leak real credentials into tests.
config({ path: '.env.test', override: true });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false,
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
