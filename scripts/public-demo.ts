/**
 * Runs the whole public demo in one container. Only the API/dashboard listens
 * on a public interface; the collector and demo services bind to 127.0.0.1 so
 * nobody outside the container can write telemetry. If any process dies the
 * container exits and the host restarts it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createDb, redactUrl } from '../packages/db/src/client';
import { runMigrations } from '../packages/db/src/migrate';

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
  await runMigrations(url);
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
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
function start(name: string, cwd: string, ...args: string[]): void {
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd,
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`${name} exited with code ${code}; stopping`);
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
  start('collector', 'apps/collector', 'src/server.ts');
  await healthy('http://127.0.0.1:4318/health');
  start('api', 'apps/api', 'src/server.ts');
  await healthy(`http://127.0.0.1:${env.API_PORT}/api/health`);
  start('demo services', 'examples/microservices', 'src/run-all.ts');
  await healthy('http://127.0.0.1:8101/health');
  start(
    'traffic',
    'examples/microservices',
    'src/scripts/traffic.ts',
    '--duration',
    'Infinity',
    '--rps',
    process.env.DEMO_RPS ?? '0.05',
  );
  console.log(`public demo ready on port ${env.API_PORT} (db ${redactUrl(DATABASE_URL)})`);
} catch (error) {
  console.error('startup failed:', (error as Error).message);
  stop(1);
}
