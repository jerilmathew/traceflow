import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run a fully isolated TraceFlow stack on non-default ports
 * against the `traceflow_e2e` database, so they never touch stored dev telemetry.
 * (The demo Inventory service still uses the shared `inventory_demo` database.)
 *
 *   demo services (18101-18103) ──OTLP/JSON──▶ collector :14318 ──▶ Postgres
 *   browser ──▶ vite :15180 ──/api proxy──▶ API :14400 ──▶ Postgres
 */
const E2E_DB =
  process.env.E2E_DATABASE_URL ?? 'postgres://traceflow:traceflow@127.0.0.1:5544/traceflow_e2e';
const PORTS = {
  collector: 14318,
  api: 14400,
  web: 15180,
  gateway: 18101,
  users: 18102,
  inventory: 18103,
};

export const E2E = {
  gatewayUrl: `http://127.0.0.1:${PORTS.gateway}`,
  apiUrl: `http://127.0.0.1:${PORTS.api}`,
};

const reuse = !process.env.CI;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORTS.web}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      name: 'collector',
      command: 'pnpm db:migrate && pnpm --filter @traceflow/collector start',
      url: `http://127.0.0.1:${PORTS.collector}/health`,
      env: { DATABASE_URL: E2E_DB, COLLECTOR_PORT: String(PORTS.collector), LOG_LEVEL: 'warn' },
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
    {
      name: 'api',
      command: 'pnpm --filter @traceflow/api start',
      url: `http://127.0.0.1:${PORTS.api}/api/health`,
      env: {
        DATABASE_URL: E2E_DB,
        API_PORT: String(PORTS.api),
        SERVE_WEB: 'false',
        LOG_LEVEL: 'warn',
      },
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
    {
      name: 'web',
      command: 'pnpm --filter @traceflow/web dev',
      url: `http://127.0.0.1:${PORTS.web}`,
      env: { WEB_PORT: String(PORTS.web), TRACEFLOW_API_URL: `http://127.0.0.1:${PORTS.api}` },
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
    {
      name: 'demo-services',
      command: 'pnpm demo:services',
      url: `http://127.0.0.1:${PORTS.gateway}/health`,
      env: {
        GATEWAY_PORT: String(PORTS.gateway),
        USERS_PORT: String(PORTS.users),
        INVENTORY_PORT: String(PORTS.inventory),
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${PORTS.collector}/v1/traces`,
        LOG_LEVEL: 'fatal',
      },
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
  ],
});
