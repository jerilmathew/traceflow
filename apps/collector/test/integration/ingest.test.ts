import { gzipSync } from 'node:zlib';
import { createDb } from '@traceflow/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../test/db';
import { buildCollector } from '../../src/app';
import { otlpPayload, randomSpanId, randomTraceId, type TestSpan } from '../helpers';

const db = testDb();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildCollector({ sql: db.sql, logLevel: 'silent' });
});
afterAll(async () => {
  await app.close();
  await db.close();
});
beforeEach(() => resetDb(db));

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/traces',
    headers: { 'content-type': 'application/json', ...headers },
    payload:
      typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
  });

const traceRow = async (traceId: string) => {
  const [row] = await db.sql`select * from traces where trace_id = ${traceId}`;
  return row;
};

/** gateway → users, gateway → inventory → db, as three services. */
function checkoutTrace() {
  const traceId = randomTraceId();
  const ids = {
    root: randomSpanId(),
    usersClient: randomSpanId(),
    users: randomSpanId(),
    inv: randomSpanId(),
    db: randomSpanId(),
  };
  const gateway: TestSpan[] = [
    { traceId, spanId: ids.root, name: 'POST /checkout', kind: 2, startMs: 0, durationMs: 480 },
    {
      traceId,
      spanId: ids.usersClient,
      parentSpanId: ids.root,
      name: 'GET /users/:id',
      kind: 3,
      startMs: 10,
      durationMs: 80,
    },
  ];
  const users: TestSpan[] = [
    {
      traceId,
      spanId: ids.users,
      parentSpanId: ids.usersClient,
      name: 'GET /users/:id',
      kind: 2,
      startMs: 12,
      durationMs: 75,
    },
  ];
  const inventory: TestSpan[] = [
    {
      traceId,
      spanId: ids.inv,
      parentSpanId: ids.root,
      name: 'POST /reservations',
      kind: 2,
      startMs: 100,
      durationMs: 300,
    },
    {
      traceId,
      spanId: ids.db,
      parentSpanId: ids.inv,
      name: 'pg.query:UPDATE',
      kind: 3,
      startMs: 120,
      durationMs: 260,
      statusCode: 2,
      statusMessage: 'violates check constraint',
      attributes: { 'db.system': 'postgresql', 'db.name': 'inventory' },
    },
  ];
  return { traceId, ids, gateway, users, inventory };
}

describe('POST /v1/traces → PostgreSQL', () => {
  it('persists spans and builds a trace summary', async () => {
    const t = checkoutTrace();
    const res = await post(
      otlpPayload({ 'api-gateway': t.gateway, users: t.users, inventory: t.inventory }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});

    const spans =
      await db.sql`select span_id, parent_span_id, duration_ms, is_error from spans where trace_id = ${t.traceId}`;
    expect(spans).toHaveLength(5);
    expect(spans.find((s) => s.span_id === t.ids.db)).toMatchObject({
      parent_span_id: t.ids.inv,
      duration_ms: 260,
      is_error: true,
    });

    const row = await traceRow(t.traceId);
    expect(row).toMatchObject({
      root_service: 'api-gateway',
      root_operation: 'POST /checkout',
      root_span_id: t.ids.root,
      has_root: true,
      span_count: 5,
      error_count: 1,
      orphan_count: 0,
      status: 'error',
      services: ['api-gateway', 'inventory', 'users'],
    });
    expect(row!.duration_ms).toBe(480);
  });

  it('upserts services by name + environment', async () => {
    const t = checkoutTrace();
    await post(otlpPayload({ 'api-gateway': t.gateway }, 'staging'));
    await post(otlpPayload({ 'api-gateway': checkoutTrace().gateway }, 'staging'));
    await post(otlpPayload({ 'api-gateway': checkoutTrace().gateway }, 'prod'));
    const rows = await db.sql`select name, environment from services order by environment`;
    expect(rows.map((r) => `${r.name}/${r.environment}`)).toEqual([
      'api-gateway/prod',
      'api-gateway/staging',
    ]);
  });

  it('is idempotent: re-sending the same batch does not duplicate spans', async () => {
    const t = checkoutTrace();
    const payload = otlpPayload({ 'api-gateway': t.gateway, users: t.users });
    expect((await post(payload)).statusCode).toBe(200);
    const before = await traceRow(t.traceId);
    // An exporter retry sends the identical batch again.
    expect((await post(payload)).statusCode).toBe(200);
    const [{ count }] =
      (await db.sql`select count(*)::int as count from spans where trace_id = ${t.traceId}`) as unknown as [
        { count: number },
      ];
    expect(count).toBe(3);
    const after = await traceRow(t.traceId);
    expect(after!.span_count).toBe(before!.span_count);
  });

  it('de-duplicates repeated spans inside a single request', async () => {
    const t = checkoutTrace();
    const payload = otlpPayload({ 'api-gateway': [...t.gateway, ...t.gateway] });
    expect((await post(payload)).statusCode).toBe(200);
    expect((await traceRow(t.traceId))!.span_count).toBe(2);
  });

  it('handles out-of-order arrival: children before their parent', async () => {
    const t = checkoutTrace();
    // The database span and the inventory server span arrive first…
    await post(otlpPayload({ inventory: t.inventory }));
    let row = await traceRow(t.traceId);
    expect(row).toMatchObject({
      has_root: false,
      span_count: 2,
      orphan_count: 1,
      root_operation: 'POST /reservations',
    });
    expect(row!.duration_ms).toBe(300);

    // …then the users span, whose parent (gateway client span) is still missing…
    await post(otlpPayload({ users: t.users }));
    row = await traceRow(t.traceId);
    expect(row).toMatchObject({ has_root: false, span_count: 3, orphan_count: 2 });
    // The earliest orphan stands in as the provisional root.
    expect(row!.root_service).toBe('users');

    // …and finally the gateway, which completes the tree.
    await post(otlpPayload({ 'api-gateway': t.gateway }));
    row = await traceRow(t.traceId);
    expect(row).toMatchObject({
      has_root: true,
      span_count: 5,
      orphan_count: 0,
      root_service: 'api-gateway',
      root_operation: 'POST /checkout',
      status: 'error',
    });
    expect(row!.duration_ms).toBe(480);
  });

  it('produces the same summary regardless of arrival order', async () => {
    const orders = [
      ['gateway', 'users', 'inventory'],
      ['inventory', 'users', 'gateway'],
      ['users', 'gateway', 'inventory'],
    ] as const;
    const summaries = [];
    for (const order of orders) {
      await resetDb(db);
      const t = checkoutTrace();
      const parts = {
        gateway: { 'api-gateway': t.gateway },
        users: { users: t.users },
        inventory: { inventory: t.inventory },
      };
      for (const part of order) await post(otlpPayload(parts[part]));
      const row = await traceRow(t.traceId);
      summaries.push({
        root: row!.root_operation,
        hasRoot: row!.has_root,
        spans: row!.span_count,
        errors: row!.error_count,
        duration: row!.duration_ms,
        orphans: row!.orphan_count,
      });
    }
    expect(summaries[1]).toEqual(summaries[0]);
    expect(summaries[2]).toEqual(summaries[0]);
  });

  it('keeps summaries correct under concurrent ingestion of the same trace', async () => {
    const traceId = randomTraceId();
    const rootId = randomSpanId();
    const children: TestSpan[] = Array.from({ length: 40 }, (_, i) => ({
      traceId,
      spanId: randomSpanId(),
      parentSpanId: rootId,
      name: `work-${i}`,
      startMs: i,
      durationMs: 5,
      statusCode: i % 10 === 0 ? 2 : 0,
    }));
    const batches = [
      [{ traceId, spanId: rootId, name: 'root', kind: 2, startMs: 0, durationMs: 100 } as TestSpan],
      ...Array.from({ length: 8 }, (_, b) => children.slice(b * 5, b * 5 + 5)),
    ];
    // Nine requests for one trace, all in flight at once, each from a separate service.
    const responses = await Promise.all(
      batches.map((spans, i) => post(otlpPayload({ [`svc-${i}`]: spans }))),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);

    const row = await traceRow(traceId);
    expect(row).toMatchObject({
      span_count: 41,
      error_count: 4,
      has_root: true,
      orphan_count: 0,
      root_operation: 'root',
    });
    expect(row!.services).toHaveLength(9);
  });

  it('returns OTLP partialSuccess for rejected spans and stores the rest', async () => {
    const t = checkoutTrace();
    const payload = otlpPayload({ 'api-gateway': t.gateway });
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans as Array<Record<string, unknown>>;
    spans.push({ ...spans[0]!, traceId: 'nope' });
    const res = await post(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json().partialSuccess.rejectedSpans).toBe('1');
    expect(res.json().partialSuccess.errorMessage).toMatch(/invalid trace id/);
    expect((await traceRow(t.traceId))!.span_count).toBe(2);
  });

  it('records span events and computes errors from the stored status', async () => {
    const traceId = randomTraceId();
    await post(
      otlpPayload({
        svc: [
          {
            traceId,
            spanId: randomSpanId(),
            name: 'boom',
            startMs: 0,
            durationMs: 10,
            statusCode: 2,
            events: [
              {
                name: 'exception',
                atMs: 5,
                attributes: { 'exception.type': 'Error', 'exception.message': 'kaput' },
              },
            ],
          },
        ],
      }),
    );
    const [span] =
      await db.sql`select events, status_code, is_error from spans where trace_id = ${traceId}`;
    expect(span!.status_code).toBe(2);
    expect(span!.events[0]).toMatchObject({
      name: 'exception',
      attributes: { 'exception.message': 'kaput' },
    });
  });
});

describe('protocol handling', () => {
  it('accepts gzip-compressed payloads', async () => {
    const t = checkoutTrace();
    const res = await post(gzipSync(JSON.stringify(otlpPayload({ 'api-gateway': t.gateway }))), {
      'content-encoding': 'gzip',
    });
    expect(res.statusCode).toBe(200);
    expect((await traceRow(t.traceId))!.span_count).toBe(2);
  });

  it('rejects protobuf with a clear 415', async () => {
    const res = await post('binary', { 'content-type': 'application/x-protobuf' });
    expect(res.statusCode).toBe(415);
    expect(res.json().message).toMatch(/http\/json/);
  });

  it('rejects malformed JSON and invalid structure with 400', async () => {
    expect((await post('{oops')).statusCode).toBe(400);
    const res = await post({ resourceSpans: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 3, message: '"resourceSpans" must be an array' });
  });

  it('rejects unsupported content encodings', async () => {
    expect((await post('{}', { 'content-encoding': 'br' })).statusCode).toBe(415);
  });

  it('enforces the decompressed body limit (gzip bomb protection)', async () => {
    const small = await buildCollector({ sql: db.sql, bodyLimit: 10_000, logLevel: 'silent' });
    const bomb = gzipSync(Buffer.alloc(1_000_000, 0x20)); // ~1KB compressed, 1MB expanded
    const res = await small.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: bomb,
    });
    expect(res.statusCode).toBe(413);
    await small.close();
  });
});

describe('resilience', () => {
  it('answers 503 + Retry-After when the database is unreachable, so exporters retry', async () => {
    const dead = createDb({ url: 'postgres://nobody:nothing@127.0.0.1:1/none', max: 1 });
    const offline = await buildCollector({ sql: dead.sql, logLevel: 'silent' });
    const t = checkoutTrace();
    const res = await offline.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(otlpPayload({ 'api-gateway': t.gateway })),
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json().code).toBe(14);

    const health = await offline.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toEqual({ status: 'degraded', database: 'down' });
    await offline.close();
    await dead.close();
  });
});
