import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@traceflow/db';
import { TEST_DATABASE_URL, testDb } from '../../../../test/db';
import { buildApi } from '../../src/app';

/** Behaviour that matters once the API is reachable from the internet. */
const db = testDb();
afterAll(() => db.close());
const base = { sql: db.sql, logLevel: 'silent', serveWeb: false, live: false } as const;

it('rate limits per client and returns the standard error shape', async () => {
  const app = await buildApi({ ...base, rateLimitPerMinute: 3, trustProxy: 'loopback' });
  const from = (ip: string) =>
    app.inject({ method: 'GET', url: '/api/health', headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 3; i++) expect((await from('203.0.113.1')).statusCode).toBe(200);
  const blocked = await from('203.0.113.1');
  expect(blocked.statusCode).toBe(429);
  expect(blocked.json().error.code).toBe('rate_limited');
  expect(blocked.headers['retry-after']).toBeDefined();
  expect((await from('203.0.113.2')).statusCode).toBe(200);
  await app.close();
});

it('cannot be bypassed by spoofing X-Forwarded-For', async () => {
  // No proxy trusted: the header is ignored.
  const direct = await buildApi({ ...base, rateLimitPerMinute: 1 });
  const hit = (app: typeof direct, xff: string) =>
    app.inject({ method: 'GET', url: '/api/health', headers: { 'x-forwarded-for': xff } });
  expect((await hit(direct, '203.0.113.1')).statusCode).toBe(200);
  expect((await hit(direct, '203.0.113.2')).statusCode).toBe(429);
  await direct.close();
  // Proxy trusted: only the address it appended counts, not what the client sent.
  const proxied = await buildApi({ ...base, rateLimitPerMinute: 1, trustProxy: 'loopback' });
  expect((await hit(proxied, '10.1.1.1, 203.0.113.9')).statusCode).toBe(200);
  expect((await hit(proxied, '10.2.2.2, 203.0.113.9')).statusCode).toBe(429);
  await proxied.close();
  // A peer outside the trusted range cannot set its own address.
  const other = await buildApi({ ...base, rateLimitPerMinute: 1, trustProxy: '198.51.100.0/24' });
  expect((await hit(other, '203.0.113.1')).statusCode).toBe(200);
  expect((await hit(other, '203.0.113.2')).statusCode).toBe(429);
  await other.close();
});

it('sends security headers and accepts no writes', async () => {
  const app = await buildApi(base);
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  for (const url of ['/v1/traces', '/api/traces']) {
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(404);
  }
  await app.close();
});

it('caps live connections per client and frees the slot on disconnect', async () => {
  const app = await buildApi(base);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/stream`;
  const open = Array.from({ length: 6 }, () => new AbortController());
  const ok = await Promise.all(open.map((c) => fetch(url, { signal: c.signal })));
  expect(ok.map((r) => r.status)).toEqual(Array(6).fill(200));
  expect((await fetch(url)).status).toBe(503);
  open[0]!.abort();
  const retry = new AbortController();
  let status = 503;
  for (let i = 0; i < 50 && status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 20));
    status = (await fetch(url, { signal: retry.signal })).status;
  }
  expect(status).toBe(200);
  for (const c of [...open, retry]) c.abort();
  await app.close();
});

describe('behind a hosting edge that sets the client IP header', () => {
  /** Stand-in for the provider's edge: replaces any x-real-ip the client sent with the true address. */
  async function withEdge(
    run: (
      request: (client: string, headers?: Record<string, string | string[]>) => Promise<number>,
    ) => Promise<void>,
  ) {
    const app = await buildApi({ ...base, rateLimitPerMinute: 3, clientIpHeader: 'x-real-ip' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const edge = http.createServer((req, res) => {
      const { 'x-sim-client': client, ...headers } = req.headers;
      http
        .get(
          {
            port,
            host: '127.0.0.1',
            path: req.url,
            headers: { ...headers, 'x-real-ip': String(client) },
          },
          (up) => {
            res.writeHead(up.statusCode ?? 500);
            up.pipe(res);
          },
        )
        .on('error', () => res.destroy());
    });
    await new Promise<void>((r) => edge.listen(0, '127.0.0.1', r));
    const edgePort = (edge.address() as AddressInfo).port;
    try {
      await run(
        (client, headers = {}) =>
          new Promise((resolve, reject) => {
            http
              .get(
                {
                  port: edgePort,
                  host: '127.0.0.1',
                  path: '/api/meta',
                  agent: false,
                  headers: { ...headers, 'x-sim-client': client },
                },
                (res) => {
                  res.resume();
                  resolve(res.statusCode ?? 0);
                },
              )
              .on('error', reject);
          }),
      );
    } finally {
      edge.closeAllConnections();
      await new Promise((r) => edge.close(r));
      await app.close();
    }
  }

  it('gives each visitor an independent quota', () =>
    withEdge(async (request) => {
      for (let i = 0; i < 3; i++) expect(await request('203.0.113.1')).toBe(200);
      expect(await request('203.0.113.1')).toBe(429);
      expect(await request('203.0.113.2')).toBe(200);
    }));

  it('ignores every forwarding header a visitor makes up', () =>
    withEdge(async (request) => {
      const spoof = (n: number) => ({
        'x-real-ip': `198.51.100.${n}`,
        'x-forwarded-for': `198.51.100.${n}, 10.0.0.${n}`,
        forwarded: `for=198.51.100.${n}`,
        'fly-client-ip': `198.51.100.${n}`,
        'cf-connecting-ip': `198.51.100.${n}`,
      });
      for (let i = 1; i <= 3; i++) expect(await request('203.0.113.1', spoof(i))).toBe(200);
      for (let i = 4; i <= 8; i++) expect(await request('203.0.113.1', spoof(i))).toBe(429);
    }));

  it('treats one IPv6 /64 as one visitor', () =>
    withEdge(async (request) => {
      for (const host of ['1', 'ffff', 'a:b:c:d']) {
        expect(
          await request(host.includes(':') ? `2001:db8:1:2:${host}` : `2001:db8:1:2::${host}`),
        ).toBe(200);
      }
      expect(await request('2001:db8:1:2::9')).toBe(429);
      expect(await request('2001:db8:1:3::9')).toBe(200);
    }));
});

it('falls back to the socket address for missing, junk or duplicated client headers', async () => {
  const app = await buildApi({ ...base, rateLimitPerMinute: 1, clientIpHeader: 'X-Real-IP' });
  const hit = async (value?: string) =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/meta',
        headers: value === undefined ? {} : { 'x-real-ip': value },
      })
    ).statusCode;
  expect(await hit()).toBe(200);
  for (const junk of [
    'not-an-ip',
    '203.0.113.1, 203.0.113.2',
    '',
    '203.0.113.1:80',
    'a'.repeat(500),
  ]) {
    expect(await hit(junk), junk.slice(0, 30)).toBe(429);
  }
  await app.close();
});

it('holds a site-wide ceiling even when every request claims a new address', async () => {
  const app = await buildApi({
    ...base,
    rateLimitPerMinute: 2,
    globalRateLimitPerMinute: 10,
    clientIpHeader: 'x-real-ip',
  });
  const codes = [];
  for (let i = 1; i <= 14; i++) {
    codes.push(
      (
        await app.inject({
          method: 'GET',
          url: '/api/meta',
          headers: { 'x-real-ip': `203.0.113.${i}` },
        })
      ).statusCode,
    );
  }
  expect(codes).toEqual([...Array(10).fill(200), ...Array(4).fill(503)]);
  await app.close();
});

it('cannot modify or delete data', async () => {
  // The API process connects exactly like this (see server.ts).
  const readOnly = createDb({
    url: TEST_DATABASE_URL,
    max: 1,
    readOnly: true,
    statementTimeoutMs: 200,
  });
  for (const query of [
    'delete from spans',
    'truncate traces',
    "insert into services (name) values ('x')",
    'drop table spans',
    'create table t (i int)',
  ]) {
    await expect(readOnly.sql.unsafe(query), query).rejects.toMatchObject({ code: '25006' });
  }
  await expect(readOnly.sql`select pg_sleep(2)`).rejects.toMatchObject({ code: '57014' });
  await readOnly.close();

  // ...and no route accepts a method that could write.
  const app = await buildApi(base);
  expect(app.printRoutes({ commonPrefix: false })).not.toMatch(/POST|PUT|PATCH|DELETE/);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    for (const url of [
      '/v1/traces',
      '/api/traces',
      '/api/meta',
      `/api/traces/${'a'.repeat(32)}`,
      '/',
    ]) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(404);
    }
  }
  await app.close();
});

it('describes the demo only on demo instances and allows no foreign origins', async () => {
  const demo = { retentionHours: 24, sourceUrl: 'https://example.com/repo' };
  const app = await buildApi({ ...base, demo, corsOrigins: [] });
  const res = await app.inject({
    method: 'GET',
    url: '/api/meta',
    headers: { origin: 'https://evil.example' },
  });
  expect(res.json()).toEqual({ demo });
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
  expect(res.headers['strict-transport-security']).toBeDefined();
  await app.close();
  const local = await buildApi(base);
  expect((await local.inject({ method: 'GET', url: '/api/meta' })).json()).toEqual({ demo: null });
  await local.close();
});

it('still receives live notifications over a read-only connection', async () => {
  const readOnly = createDb({ url: TEST_DATABASE_URL, max: 2, readOnly: true });
  const app = await buildApi({
    sql: readOnly.sql,
    logLevel: 'silent',
    serveWeb: false,
    live: true,
  });
  for (let i = 0; i < 100 && !app.live.listening; i++) await new Promise((r) => setTimeout(r, 20));
  expect(app.live.listening).toBe(true);
  await app.close();
  await readOnly.close();
});
