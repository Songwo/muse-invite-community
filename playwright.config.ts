import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const remote = process.env.MUSE_E2E_REMOTE === '1';
const runId = `${process.pid}-${Date.now()}`;
const databasePath = `./data/e2e-${runId}.sqlite`;
const workerStatePath = fileURLToPath(new URL('../../work/e2e-worker-state', import.meta.url));
const workerLogPath = fileURLToPath(new URL('../../work/e2e-wrangler-logs', import.meta.url));

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5186', trace: 'retain-on-failure' },
  projects: [{ name: 'edge', use: { ...devices['Desktop Chrome'], channel: 'msedge' } }],
  webServer: [
    ...(remote ? [{
      command: `npx wrangler dev --ip 127.0.0.1 --port 8789 --local --persist-to "${workerStatePath}" --var ALLOWED_ORIGIN:http://127.0.0.1:5186 --var COMMUNITY_ID:muse-e2e-${runId}`,
      url: 'http://127.0.0.1:8789/api/health',
      reuseExistingServer: false,
      timeout: 120000,
      env: { WRANGLER_LOG_PATH: workerLogPath },
    }] : []),
    {
      command: 'npm run dev -- --port 5186 --strictPort',
      url: 'http://127.0.0.1:5186',
      reuseExistingServer: false,
      env: {
        DATABASE_PATH: databasePath,
        VITE_API_URL: remote ? 'http://127.0.0.1:8789' : '',
      },
    },
  ],
});
