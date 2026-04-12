import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:9880',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node --enable-source-maps dist/index.js',
    port: 9880,
    reuseExistingServer: false,
    timeout: 15000,
  },
});
