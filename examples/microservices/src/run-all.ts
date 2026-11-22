/**
 * Starts the three demo services as separate OS processes (so traces really
 * cross process boundaries) and waits until each one is healthy.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATEWAY_URL, INVENTORY_URL, USERS_URL } from './common/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const services = [
  { name: 'inventory', url: INVENTORY_URL, color: '\x1b[36m' },
  { name: 'users', url: USERS_URL, color: '\x1b[35m' },
  { name: 'gateway', url: GATEWAY_URL, color: '\x1b[34m' },
] as const;

const children: ChildProcess[] = [];

function start(name: string, color: string): ChildProcess {
    // `--import tsx` enables TypeScript; the instrument file then starts the
  // OpenTelemetry SDK before the service's own modules are loaded.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', `./src/${name}/instrument.ts`, `src/${name}/server.ts`],
    {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (data: Buffer) =>
    data.toString().split('\n').filter(Boolean).forEach((line) => console.log(prefix + line));
  child.stdout?.on('data', pipe);
  child.stderr?.on('data', pipe);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    if (!stopping) stopAll(1);
  });
  return child;
}

async function waitHealthy(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs}ms`);
}

let stopping = false;
function stopAll(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

for (const s of services) children.push(start(s.name, s.color));
await Promise.all(services.map((s) => waitHealthy(s.url)));
console.log('\n✓ demo services ready');
console.log(`  api-gateway        ${GATEWAY_URL}`);
console.log(`  users-service      ${USERS_URL}`);
console.log(`  inventory-service  ${INVENTORY_URL}`);
console.log('\n  Generate traffic:  pnpm demo   (scenarios A/B/C)   |   pnpm demo:traffic\n');
