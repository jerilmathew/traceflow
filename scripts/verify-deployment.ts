/**
 * Checks a running public demo from the outside, without writing anything:
 *
 *   pnpm verify:deployment https://your-demo.example
 *
 * The spoofing check sends made-up forwarding headers and watches the rate
 * limit counter: if a fake address ever gets a fresh quota, it fails.
 */
const base = process.argv[2]?.replace(/\/$/, '');
if (!base) throw new Error('usage: pnpm verify:deployment <url>');

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` (${String(detail)})`}`);
}
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers, redirect: 'manual' });

const home = await get('/');
check(
  'dashboard opens without sign-up',
  home.status === 200 && (await home.text()).includes('TraceFlow'),
);
const header = (name: string) => home.headers.get(name) ?? '';
const csp = header('content-security-policy');
check(
  'content security policy',
  csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'"),
);
check('no inline or third-party scripts allowed', !/script-src[^;]*(unsafe|http)/.test(csp));
check(
  'nosniff, referrer and permissions policies',
  header('x-content-type-options') === 'nosniff' &&
    header('referrer-policy') === 'no-referrer' &&
    header('permissions-policy') !== '',
);
check('HSTS', header('strict-transport-security') !== '');
if (base.startsWith('https:')) {
  const plain = await fetch(base.replace('https:', 'http:'), { redirect: 'manual' }).catch(
    () => null,
  );
  check(
    'plain HTTP is redirected or refused',
    !plain || (plain.status >= 300 && plain.status < 400),
    plain?.status,
  );
}

const cors = await get('/api/meta', { origin: 'https://evil.example' });
check('no cross-origin access', cors.headers.get('access-control-allow-origin') === null);
check('demo notice enabled', ((await cors.json()) as { demo: unknown }).demo !== null);

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const codes = [];
  for (const path of ['/v1/traces', '/api/traces', '/api/meta']) {
    codes.push(
      (
        await fetch(
          base + path,
          method === 'DELETE'
            ? { method }
            : { method, body: '{}', headers: { 'content-type': 'application/json' } },
        )
      ).status,
    );
  }
  check(
    `${method} is refused everywhere, including trace ingestion`,
    codes.every((c) => c === 404 || c === 405),
    codes,
  );
}

const overview = (await (await get('/api/overview?window=1h')).json()) as {
  traceCount: number;
  errorTraceCount: number;
  serviceCount: number;
  latency: { p50: number; p95: number };
};
check('dashboard has recent traces', overview.traceCount >= 20, overview.traceCount);
check('includes failed traces', overview.errorTraceCount > 0, overview.errorTraceCount);
check(
  'latency has a slow tail',
  overview.latency.p95 > overview.latency.p50 * 3,
  `p50 ${overview.latency.p50.toFixed(1)}ms, p95 ${overview.latency.p95.toFixed(1)}ms`,
);
const graph = (await (await get('/api/dependencies?window=1h')).json()) as { edges: unknown[] };
check(
  'service dependencies observed',
  overview.serviceCount === 3 && graph.edges.length >= 3,
  graph.edges.length,
);
check('oversized queries rejected', (await get('/api/traces?pageSize=1000')).status === 400);

const abort = new AbortController();
const stream = await fetch(`${base}/api/stream`, { signal: abort.signal });
const first = stream.body
  ? new TextDecoder().decode((await stream.body.getReader().read()).value)
  : '';
check('live stream connects', stream.status === 200 && first.includes('retry:'));
abort.abort();

const remaining = async (headers: Record<string, string> = {}) =>
  Number((await get('/api/meta', headers)).headers.get('x-ratelimit-remaining'));
const start = await remaining();
check('rate limit active', Number.isFinite(start) && start > 20, `${start} left`);
let last = start;
let fresh = 0;
for (let i = 1; i <= 8; i++) {
  const ip = `198.51.100.${i}`;
  const now = await remaining({
    'x-real-ip': ip,
    'x-forwarded-for': `${ip}, 10.0.0.${i}`,
    'fly-client-ip': ip,
    'cf-connecting-ip': ip,
    'true-client-ip': ip,
    forwarded: `for=${ip}`,
  });
  if (now >= last) fresh++;
  last = now;
}
check('spoofed client addresses get no extra quota', fresh === 0, `${start} → ${last}`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

export {};
