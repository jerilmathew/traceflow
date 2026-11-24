import type { AddressInfo } from 'node:net';
import { afterAll, expect, it } from 'vitest';
import { testDb } from '../../../../test/db';
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
