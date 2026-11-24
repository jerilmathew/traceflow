/**
 * Runs the whole public demo in one container. Only the API/dashboard listens
 * on a public interface; the collector and demo services bind to 127.0.0.1 so
 * nobody outside the container can write telemetry. If any process dies the
 * container exits and the host restarts it. Runs from the output of
 * build-public-demo.ts (plain JavaScript, no TypeScript loader at runtime).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATEWAY_URL } from '../examples/microservices/src/common/config';
import { SCENARIOS, runScenario } from '../examples/microservices/src/scripts/scenarios-def';
import { runTraffic } from '../examples/microservices/src/scripts/traffic-lib';
import { createDb, redactUrl } from '../packages/db/src/client';
import { runMigrations } from '../packages/db/src/migrate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const inventoryUrl = new URL(DATABASE_URL);
inventoryUrl.pathname = '/inventory_demo';

/** Wait for PostgreSQL, then make sure the demo service has its own database. */
async function prepareDatabases(url: string): Promise<void> {
  const { sql, close } = createDb({ url, max: 1, applicationName: 'traceflow-setup' });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await sql`select 1`;
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    const [existing] = await sql`select 1 from pg_database where datname = 'inventory_demo'`;
    if (!existing) await sql.unsafe('create database inventory_demo');
  } finally {
    await close();
  }
  await runMigrations(url, path.join(ROOT, 'drizzle'));
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  TRACEFLOW_ROOT: ROOT,
  INVENTORY_DATABASE_URL: inventoryUrl.toString(),
  API_HOST: '0.0.0.0',
  API_PORT: process.env.PORT ?? '8080',
  COLLECTOR_HOST: '127.0.0.1',
  COLLECTOR_PORT: '4318',
  DEMO_HOST: '127.0.0.1',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
  CORS_ORIGINS: '',
  DEPLOY_ENV: 'public-demo',
  RETENTION_HOURS: process.env.RETENTION_HOURS ?? '24',
  PUBLIC_DEMO: 'true',
  GLOBAL_RATE_LIMIT_PER_MINUTE: process.env.GLOBAL_RATE_LIMIT_PER_MINUTE ?? '3000',
  RATE_LIMIT_PER_MINUTE: process.env.RATE_LIMIT_PER_MINUTE ?? '300',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
};

const children: ChildProcess[] = [];
let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3_000);
}
function start(name: string, dir: string, ...preload: string[]): void {
  const child = spawn(
    process.execPath,
    [
      // Small heaps: each process does little work and the container is memory-billed.
      '--max-old-space-size=96',
      '--max-semi-space-size=1',
      ...preload.flatMap((file) => ['--import', `./${dir}/${file}`]),
      `${dir}/server.js`,
    ],
    { cwd: ROOT, env, stdio: 'inherit' },
  );
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${name} exited (${signal ?? `code ${code}`}); stopping`);
    stop(1);
  });
  children.push(child);
}
async function healthy(url: string): Promise<void> {
  for (let i = 0; i < 120 && !stopping; i++) {
    const ok = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not become healthy`);
}
process.once('SIGTERM', () => stop(0));
process.once('SIGINT', () => stop(0));

try {
  await prepareDatabases(DATABASE_URL);
  start('collector', 'apps/collector/src');
  await healthy('http://127.0.0.1:4318/health');
  start('api', 'apps/api/src');
  await healthy(`http://127.0.0.1:${env.API_PORT}/api/health`);
  for (const [name, port] of [
    ['users', 8102],
    ['inventory', 8103],
    ['gateway', 8101],
  ] as const) {
    start(name, `examples/microservices/src/${name}`, 'instrument.js');
    await healthy(`http://127.0.0.1:${port}/health`);
  }
  console.log(`public demo ready on port ${env.API_PORT} (db ${redactUrl(DATABASE_URL)})`);

  const shouldStop = () => stopping;
  const overview = (await (
    await fetch(`http://127.0.0.1:${env.API_PORT}/api/overview?window=1h`)
  ).json()) as { traceCount: number };
  // A visitor should never meet an empty dashboard after a fresh start.
  if (overview.traceCount < 60) {
    // One of each scenario first, so slow and failed requests are always represented.
    for (const scenario of SCENARIOS) await runScenario(GATEWAY_URL, scenario);
    await runTraffic({ durationS: 30, rps: 4, seed: 7, shouldStop });
  }
  const rps = Number(process.env.DEMO_RPS ?? '0.05');
  await runTraffic({ durationS: Infinity, rps, seed: Date.now(), shouldStop });
} catch (error) {
  console.error('startup failed:', (error as Error).message);
  stop(1);
}
