import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  latencyPercentiles,
  type DependencyGraph,
  type Paginated,
  type ServiceDetail,
  type TraceDetail,
  type TraceSummary,
} from '@traceflow/shared';
import { resetDb, testDb } from '../../../../test/db';
import { ingestSpans } from '../../../collector/src/ingest';
import { parseExportTraceServiceRequest } from '../../../collector/src/otlp/parse';
import {
  otlpPayload,
  randomSpanId,
  randomTraceId,
  type TestSpan,
} from '../../../collector/test/helpers';
import { OPENAPI_PATH, buildApi } from '../../src/app';

const db = testDb();
let app: Awaited<ReturnType<typeof buildApi>>;

beforeAll(async () => {
  app = await buildApi({ sql: db.sql, logLevel: 'silent', serveWeb: false });
});
afterAll(async () => {
  await app.close();
  await db.close();
});
beforeEach(() => resetDb(db));

async function ingest(groups: Record<string, TestSpan[]>) {
  const { spans, rejected } = parseExportTraceServiceRequest(otlpPayload(groups));
  expect(rejected).toEqual([]);
  return ingestSpans(db.sql, spans);
}

const get = async <T>(url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T };
};

/** A gateway → users / inventory → postgres trace with configurable latency and outcome. */
async function seedCheckout(opts: { inventoryMs?: number; fail?: boolean; startMs?: number } = {}) {
  const traceId = randomTraceId();
  const start = opts.startMs ?? 0;
  const inv = opts.inventoryMs ?? 50;
  const root = randomSpanId();
  const usersClient = randomSpanId();
  const invClient = randomSpanId();
  const invServer = randomSpanId();
  await ingest({
    'api-gateway': [
      {
        traceId,
        spanId: root,
        name: 'POST /checkout',
        kind: 2,
        startMs: start,
        durationMs: inv + 40,
        statusCode: opts.fail ? 2 : 0,
      },
      {
        traceId,
        spanId: usersClient,
        parentSpanId: root,
        name: 'GET /users/:id',
        kind: 3,
        startMs: start + 2,
        durationMs: 10,
      },
      {
        traceId,
        spanId: invClient,
        parentSpanId: root,
        name: 'POST /reservations',
        kind: 3,
        startMs: start + 15,
        durationMs: inv + 4,
        statusCode: opts.fail ? 2 : 0,
      },
    ],
    'users-service': [
      {
        traceId,
        spanId: randomSpanId(),
        parentSpanId: usersClient,
        name: 'GET /users/:id',
        kind: 2,
        startMs: start + 3,
        durationMs: 8,
      },
    ],
    'inventory-service': [
      {
        traceId,
        spanId: invServer,
        parentSpanId: invClient,
        name: 'POST /reservations',
        kind: 2,
        startMs: start + 16,
        durationMs: inv,
        statusCode: opts.fail ? 2 : 0,
      },
      {
        traceId,
        spanId: randomSpanId(),
        parentSpanId: invServer,
        name: 'pg.query:UPDATE inventory_demo',
        kind: 3,
        startMs: start + 18,
        durationMs: inv - 5,
        statusCode: opts.fail ? 2 : 0,
        attributes: { 'db.system': 'postgresql', 'db.name': 'inventory_demo' },
        events: opts.fail
          ? [
              {
                name: 'exception',
                atMs: start + 20,
                attributes: { 'exception.message': 'check constraint' },
              },
            ]
          : [],
      },
    ],
  });
  return traceId;
}

describe('GET /api/traces', () => {
  it('lists traces newest first with summaries', async () => {
    const a = await seedCheckout({ startMs: 0 });
    const b = await seedCheckout({ startMs: 1000 });
    const { status, body } = await get<Paginated<TraceSummary>>('/api/traces');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.items.map((t) => t.traceId)).toEqual([b, a]);
    expect(body.items[0]).toMatchObject({
      rootService: 'api-gateway',
      rootOperation: 'POST /checkout',
      spanCount: 6,
      status: 'ok',
      hasRoot: true,
      services: ['api-gateway', 'inventory-service', 'users-service'],
    });
  });

  it('filters by status, duration, service and text', async () => {
    const fast = await seedCheckout({ inventoryMs: 20 });
    const slow = await seedCheckout({ inventoryMs: 450 });
    const failed = await seedCheckout({ inventoryMs: 30, fail: true });
    await ingest({
      lonely: [
        {
          traceId: randomTraceId(),
          spanId: randomSpanId(),
          name: 'cron.cleanup',
          startMs: 0,
          durationMs: 5,
        },
      ],
    });

    const ids = async (query: string) =>
      (await get<Paginated<TraceSummary>>(`/api/traces?${query}`)).body.items
        .map((t) => t.traceId)
        .sort();

    expect(await ids('status=error')).toEqual([failed]);
    expect(await ids('minDurationMs=400')).toEqual([slow]);
    expect(await ids('maxDurationMs=70&service=api-gateway')).toEqual([fast, failed].sort());
    expect(await ids('service=lonely')).toHaveLength(1);
    expect(await ids('q=cron')).toHaveLength(1);
    expect(await ids(`q=${slow.slice(0, 10)}`)).toEqual([slow]);
    expect(await ids('q=%25')).toEqual([]); // LIKE wildcards are matched literally
  });

  it('sorts and paginates', async () => {
    for (const ms of [100, 300, 200, 50, 400]) await seedCheckout({ inventoryMs: ms });
    const page1 = (
      await get<Paginated<TraceSummary>>('/api/traces?sort=duration&order=desc&pageSize=2')
    ).body;
    const page2 = (
      await get<Paginated<TraceSummary>>('/api/traces?sort=duration&order=desc&pageSize=2&page=2')
    ).body;
    const page3 = (
      await get<Paginated<TraceSummary>>('/api/traces?sort=duration&order=desc&pageSize=2&page=3')
    ).body;
    expect(page1.total).toBe(5);
    const durations = [...page1.items, ...page2.items, ...page3.items].map((t) => t.durationMs);
    expect(durations).toEqual([440, 340, 240, 140, 90]);
    expect(page3.items).toHaveLength(1);
  });

  it('filters by time range', async () => {
    await seedCheckout();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(
      (await get<Paginated<TraceSummary>>(`/api/traces?from=${encodeURIComponent(future)}`)).body
        .total,
    ).toBe(0);
  });

  it('validates query parameters with a consistent error shape', async () => {
    const res = await get<{ error: { code: string; details: unknown[] } }>(
      '/api/traces?pageSize=1000&sort=bogus',
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(2);
    expect((await get('/api/traces?minDurationMs=10&maxDurationMs=5')).status).toBe(400);
  });
});

describe('GET /api/traces/:id', () => {
  it('returns every span with exact relative offsets', async () => {
    const traceId = await seedCheckout({ inventoryMs: 100, fail: true });
    const { status, body } = await get<TraceDetail>(`/api/traces/${traceId}`);
    expect(status).toBe(200);
    expect(body.spans).toHaveLength(6);
    expect(body.truncated).toBe(false);
    const db = body.spans.find((s) => s.operationName.startsWith('pg.query'))!;
    expect(db.offsetMs).toBe(18);
    expect(db.durationMs).toBe(95);
    expect(db.kind).toBe('client');
    expect(db.statusCode).toBe('error');
    expect(db.attributes['db.system']).toBe('postgresql');
    expect(db.events[0]).toMatchObject({ name: 'exception', offsetMs: 20 });
    expect(db.resourceAttributes['service.name']).toBe('inventory-service');
    // Parent links survive the round trip.
    const parent = body.spans.find((s) => s.spanId === db.parentSpanId)!;
    expect(parent.service).toBe('inventory-service');
    expect(BigInt(db.startTimeUnixNano) - BigInt(body.spans[0]!.startTimeUnixNano)).toBe(
      18_000_000n,
    );
  });

  it('404s for unknown traces and 400s for malformed ids', async () => {
    expect((await get(`/api/traces/${randomTraceId()}`)).status).toBe(404);
    expect((await get('/api/traces/not-a-trace')).status).toBe(400);
    expect((await get(`/api/traces/${'0'.repeat(32)}`)).status).toBe(400);
  });
});

describe('metrics', () => {
  it('computes overview percentiles identical to the shared TypeScript implementation', async () => {
    const latencies = [20, 25, 30, 35, 40, 60, 90, 150, 300, 460];
    for (const ms of latencies) await seedCheckout({ inventoryMs: ms });
    await seedCheckout({ inventoryMs: 25, fail: true });

    const { body } = await get<{
      traceCount: number;
      errorRate: number;
      latency: Record<string, number>;
      serviceCount: number;
      timeseries: Array<{ count: number }>;
    }>('/api/overview?window=15m');
    expect(body.traceCount).toBe(11);
    expect(body.errorRate).toBeCloseTo(1 / 11, 10);
    expect(body.serviceCount).toBe(3);
    expect(body.timeseries.reduce((n, b) => n + b.count, 0)).toBe(11);

    const expected = latencyPercentiles([...latencies.map((ms) => ms + 40), 65]);
    expect(body.latency.p50).toBeCloseTo(expected.p50!, 9);
    expect(body.latency.p95).toBeCloseTo(expected.p95!, 9);
    expect(body.latency.p99).toBeCloseTo(expected.p99!, 9);
  });

  it('derives service dependencies only from observed parent/child links', async () => {
    await seedCheckout({ inventoryMs: 40 });
    await seedCheckout({ inventoryMs: 80, fail: true });
    // An orphan span from a fourth service: its caller is unknown, so no edge may be invented.
    await ingest({
      billing: [
        {
          traceId: randomTraceId(),
          spanId: randomSpanId(),
          parentSpanId: randomSpanId(),
          name: 'charge',
          kind: 2,
          startMs: 0,
          durationMs: 5,
        },
      ],
    });

    const { body } = await get<DependencyGraph>('/api/dependencies?window=15m');
    const edges = body.edges.map(
      (e) => `${e.source}->${e.target}:${e.targetKind}:${e.callCount}:${e.errorCount}`,
    );
    expect(edges).toEqual([
      'api-gateway->inventory-service:service:2:1',
      'api-gateway->users-service:service:2:0',
      'inventory-service->postgresql:inventory_demo:database:2:1',
    ]);
    expect(body.edges.some((e) => e.source === 'billing' || e.target === 'billing')).toBe(false);
    expect(body.nodes.find((n) => n.id === 'postgresql:inventory_demo')).toMatchObject({
      kind: 'database',
      requestCount: 2,
    });
    expect(body.nodes.find((n) => n.id === 'billing')).toMatchObject({
      kind: 'service',
      requestCount: 1,
    });
  });

  it('reports per-service RED metrics, operations and a latency histogram', async () => {
    for (const ms of [10, 30, 70]) await seedCheckout({ inventoryMs: ms });
    await seedCheckout({ inventoryMs: 600, fail: true });

    const list = await get<{
      items: Array<{ name: string; requestCount: number; errorCount: number }>;
    }>('/api/services?window=15m');
    expect(list.body.items.map((s) => [s.name, s.requestCount, s.errorCount])).toEqual([
      ['api-gateway', 4, 1],
      ['inventory-service', 4, 1],
      ['users-service', 4, 0],
    ]);

    const { status, body } = await get<ServiceDetail>('/api/services/inventory-service?window=15m');
    expect(status).toBe(200);
    expect(body.service.errorRate).toBe(0.25);
    expect(body.histogram.reduce((n, b) => n + b.count, 0)).toBe(4);
    expect(body.histogram.find((b) => b.fromMs === 500)!.count).toBe(1);
    expect(body.operations.map((o) => `${o.name}/${o.kind}/${o.count}`).sort()).toEqual([
      'POST /reservations/server/4',
      'pg.query:UPDATE inventory_demo/client/4',
    ]);
    expect(body.upstream.map((e) => e.source)).toEqual(['api-gateway']);
    expect(body.downstream.map((e) => e.target)).toEqual(['postgresql:inventory_demo']);
    expect(body.recentTraces).toHaveLength(4);

    expect((await get('/api/services/does-not-exist')).status).toBe(404);
  });
});

describe('GET /api/stream (SSE)', () => {
  it('pushes newly ingested traces to connected clients', async () => {
    const live = await buildApi({ sql: db.sql, logLevel: 'silent', serveWeb: false, live: true });
    await live.listen({ host: '127.0.0.1', port: 0 });
    const { port } = live.server.address() as AddressInfo;
    // Wait until LISTEN is active.
    for (let i = 0; i < 50 && !live.live.listening; i++)
      await new Promise((r) => setTimeout(r, 50));

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!buffer.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    };

    await readUntil('event: ready');
    expect(live.live.subscriberCount).toBe(1);
    const traceId = await seedCheckout();
    const text = await readUntil(traceId);
    const match = /event: traces\ndata: (.*)\n/.exec(text);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]!) as { traces: TraceSummary[] };
    expect(payload.traces[0]).toMatchObject({ traceId, spanCount: 6 });

    controller.abort();
    // The server must release the subscription when the client disconnects.
    for (let i = 0; i < 50 && live.live.subscriberCount > 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(live.live.subscriberCount).toBe(0);
    await live.close();
  });
});

describe('API surface', () => {
  it('documents every route in docs/openapi.yaml', () => {
    const spec = parseYaml(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, unknown>;
    };
    const documented = new Set(Object.keys(spec.paths).map((p) => p.replace(/\{(\w+)\}/g, ':$1')));
    const routes = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .map((line) => /(\/api\/[^\s(]*)\s*\(/.exec(line)?.[1])
      .filter((r): r is string => Boolean(r));
    expect(routes.length).toBeGreaterThan(5);
    for (const route of routes) expect(documented, `undocumented route ${route}`).toContain(route);
  });

  it('reports health and returns JSON 404s', async () => {
    const health = await get<{ status: string; database: string }>('/api/health');
    expect(health.body).toMatchObject({ status: 'ok', database: 'up' });
    const missing = await get<{ error: { code: string } }>('/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('restricts CORS to configured origins', async () => {
    const restricted = await buildApi({
      sql: db.sql,
      logLevel: 'silent',
      serveWeb: false,
      live: false,
      corsOrigins: ['http://localhost:5180'],
    });
    const allowed = await restricted.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5180' },
    });
    const denied = await restricted.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5180');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    await restricted.close();
  });
});
