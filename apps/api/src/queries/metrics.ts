/**
 * Aggregations over stored telemetry. Everything here is computed from the
 * `traces` and `spans` tables at query time — there are no pre-aggregated or
 * synthetic numbers.
 *
 * Definitions:
 * - A *request* to a service is one of its **entry spans**: kind SERVER or
 *   CONSUMER, or a span with no parent at all (a root).
 * - Service latency percentiles use entry-span durations, so they measure the
 *   time the service took to answer, including its downstream calls.
 * - Percentiles use `percentile_cont` (linear interpolation), identical to
 *   `percentile()` in @traceflow/shared.
 */
import type { Sql } from '@traceflow/db';
import {
  WINDOW_BUCKET_SECONDS,
  WINDOW_SECONDS,
  type DependencyEdge,
  type DependencyGraph,
  type DependencyNode,
  type HistogramBucket,
  type NodeKind,
  type OperationSummary,
  type Overview,
  type ServiceDetail,
  type ServiceSummary,
  type TimeBucket,
  type TimeWindow,
} from '@traceflow/shared';
import { spanKindName } from '../mappers';
import { recentTraces } from './traces';

export interface WindowRange {
  window: TimeWindow;
  from: Date;
  to: Date;
  seconds: number;
  bucketSeconds: number;
}

export function windowRange(window: TimeWindow, now = new Date()): WindowRange {
  const seconds = WINDOW_SECONDS[window];
  return {
    window,
    from: new Date(now.getTime() - seconds * 1000),
    to: now,
    seconds,
    bucketSeconds: WINDOW_BUCKET_SECONDS[window],
  };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** SQL fragment selecting a span's "entry span" status. */
const ENTRY_SPAN = 's.kind in (2, 5) or s.parent_span_id is null';

async function timeseries(
  sql: Sql,
  range: WindowRange,
  source: 'traces' | { serviceName: string },
): Promise<TimeBucket[]> {
  // bucketSeconds comes from a fixed whitelist (WINDOW_BUCKET_SECONDS), never
  // from user input, so it is safe to inline. (Re-using one parameterised
  // fragment several times in a postgres.js query is not supported.)
  const bucket = sql.unsafe(`interval '${Math.trunc(range.bucketSeconds)} seconds'`);
  // date_bin aligns buckets to a fixed origin so the series is stable between refreshes.
  const rows =
    source === 'traces'
      ? await sql`
          with b as (
            select generate_series(
              date_bin(${bucket}, ${range.from}::timestamptz, timestamptz 'epoch'),
              ${range.to}::timestamptz, ${bucket}) as ts
          )
          select b.ts, count(t.trace_id)::int as count,
            (count(*) filter (where t.status = 'error'))::int as errors,
            percentile_cont(0.95) within group (order by t.duration_ms) as p95
          from b
          left join traces t on t.start_time >= b.ts and t.start_time < b.ts + ${bucket}
            and t.start_time >= ${range.from}
          group by b.ts order by b.ts`
      : await sql`
          with b as (
            select generate_series(
              date_bin(${bucket}, ${range.from}::timestamptz, timestamptz 'epoch'),
              ${range.to}::timestamptz, ${bucket}) as ts
          ),
          e as (
            select s.start_time, s.duration_ms, s.is_error
            from spans s join services sv on sv.id = s.service_id
            where sv.name = ${source.serviceName} and s.start_time >= ${range.from}
              and (${sql.unsafe(ENTRY_SPAN)})
          )
          select b.ts, count(e.start_time)::int as count,
            (count(*) filter (where e.is_error))::int as errors,
            percentile_cont(0.95) within group (order by e.duration_ms) as p95
          from b left join e on e.start_time >= b.ts and e.start_time < b.ts + ${bucket}
          group by b.ts order by b.ts`;
  return (rows as unknown as Array<{ ts: Date; count: number; errors: number; p95: number | null }>).map((r) => ({
    ts: r.ts.toISOString(),
    count: r.count,
    errors: r.errors,
    p95: num(r.p95),
  }));
}

export async function listServices(sql: Sql, range: WindowRange, onlyName?: string): Promise<ServiceSummary[]> {
  const rows = (await sql`
    with active as (
      select distinct s.service_id from spans s where s.start_time >= ${range.from}
    ),
    entry as (
      select s.service_id,
        count(*)::int as requests,
        (count(*) filter (where s.is_error))::int as errors,
        percentile_cont(0.5) within group (order by s.duration_ms) as p50,
        percentile_cont(0.95) within group (order by s.duration_ms) as p95,
        percentile_cont(0.99) within group (order by s.duration_ms) as p99
      from spans s
      where s.start_time >= ${range.from} and (${sql.unsafe(ENTRY_SPAN)})
      group by s.service_id
    )
    select sv.name, nullif(sv.environment, '') as environment, sv.last_seen_at,
      coalesce(e.requests, 0) as requests, coalesce(e.errors, 0) as errors, e.p50, e.p95, e.p99
    from services sv
    join active a on a.service_id = sv.id
    left join entry e on e.service_id = sv.id
    ${onlyName ? sql`where sv.name = ${onlyName}` : sql``}
    order by sv.name
  `) as unknown as Array<{
    name: string;
    environment: string | null;
    last_seen_at: Date;
    requests: number;
    errors: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  }>;

  // A service name may be reported from several environments; merge by name
  // (the dashboard is name-centric), keeping the request-weighted figures.
  const byName = new Map<string, ServiceSummary>();
  for (const r of rows) {
    const existing = byName.get(r.name);
    const summary: ServiceSummary = {
      name: r.name,
      environment: r.environment,
      requestCount: r.requests,
      errorCount: r.errors,
      errorRate: ratio(r.errors, r.requests),
      requestRate: r.requests / range.seconds,
      latency: { p50: num(r.p50), p95: num(r.p95), p99: num(r.p99) },
      lastSeen: r.last_seen_at.toISOString(),
    };
    if (!existing || existing.requestCount < summary.requestCount) byName.set(r.name, summary);
  }
  return [...byName.values()];
}

export async function getOverview(sql: Sql, range: WindowRange): Promise<Overview> {
  const [[totals], [{ service_count }], series, services, recent] = await Promise.all([
    sql`
      select count(*)::int as trace_count,
        coalesce(sum(span_count), 0)::int as span_count,
        (count(*) filter (where status = 'error'))::int as error_count,
        percentile_cont(0.5) within group (order by duration_ms) as p50,
        percentile_cont(0.95) within group (order by duration_ms) as p95,
        percentile_cont(0.99) within group (order by duration_ms) as p99
      from traces where start_time >= ${range.from}
    ` as unknown as Promise<
      [{ trace_count: number; span_count: number; error_count: number; p50: number | null; p95: number | null; p99: number | null }]
    >,
    sql`
      select count(distinct sv.name)::int as service_count
      from spans s join services sv on sv.id = s.service_id where s.start_time >= ${range.from}
    ` as unknown as Promise<[{ service_count: number }]>,
    timeseries(sql, range, 'traces'),
    listServices(sql, range),
    recentTraces(sql, 10),
  ]);

  return {
    window: range.window,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    traceCount: totals.trace_count,
    spanCount: totals.span_count,
    errorTraceCount: totals.error_count,
    errorRate: ratio(totals.error_count, totals.trace_count),
    requestRate: totals.trace_count / range.seconds,
    latency: { p50: num(totals.p50), p95: num(totals.p95), p99: num(totals.p99) },
    serviceCount: service_count,
    timeseries: series,
    bucketSeconds: range.bucketSeconds,
    slowestServices: services
      .filter((s) => s.latency.p95 !== null)
      .sort((a, b) => (b.latency.p95 ?? 0) - (a.latency.p95 ?? 0))
      .slice(0, 5),
    recentTraces: recent,
  };
}

/**
 * Service dependencies, derived purely from parent/child links:
 *
 * 1. service → service: a span whose parent span belongs to a *different*
 *    service. In practice that is the callee's SERVER span under the caller's
 *    CLIENT span, i.e. one observed call. Latency/error figures are the
 *    callee's server-side view.
 * 2. service → database / messaging system: CLIENT (or PRODUCER) spans carrying
 *    `db.system(.name)` / `messaging.system` attributes. The remote system
 *    doesn't report its own spans, so the edge is inferred from the caller's
 *    span attributes and drawn as a different node kind.
 *
 * Edges are only as complete as the data: a call whose parent span hasn't
 * arrived yet cannot be attributed until it does.
 */
export async function getDependencyGraph(sql: Sql, range: WindowRange): Promise<DependencyGraph> {
  const [serviceEdges, externalEdges, services] = await Promise.all([
    sql`
      select ps.name as source, cs.name as target,
        count(*)::int as calls,
        (count(*) filter (where c.is_error))::int as errors,
        percentile_cont(0.5) within group (order by c.duration_ms) as p50,
        percentile_cont(0.95) within group (order by c.duration_ms) as p95,
        percentile_cont(0.99) within group (order by c.duration_ms) as p99
      from spans c
      join spans p on p.trace_id = c.trace_id and p.span_id = c.parent_span_id
      join services cs on cs.id = c.service_id
      join services ps on ps.id = p.service_id
      where c.start_time >= ${range.from} and cs.name <> ps.name
      group by ps.name, cs.name
    ` as unknown as Promise<EdgeRow[]>,
    sql`
      select sv.name as source,
        case when s.kind = 4 or s.attributes ? 'messaging.system' then 'messaging' else 'database' end as kind,
        coalesce(s.attributes->>'db.system.name', s.attributes->>'db.system', s.attributes->>'messaging.system')
          || coalesce(':' || coalesce(s.attributes->>'db.namespace', s.attributes->>'db.name', s.attributes->>'messaging.destination.name'), '')
          as target,
        count(*)::int as calls,
        (count(*) filter (where s.is_error))::int as errors,
        percentile_cont(0.5) within group (order by s.duration_ms) as p50,
        percentile_cont(0.95) within group (order by s.duration_ms) as p95,
        percentile_cont(0.99) within group (order by s.duration_ms) as p99
      from spans s join services sv on sv.id = s.service_id
      where s.start_time >= ${range.from}
        and s.kind in (3, 4)
        and (s.attributes ? 'db.system' or s.attributes ? 'db.system.name' or s.attributes ? 'messaging.system')
      group by 1, 2, 3
    ` as unknown as Promise<Array<EdgeRow & { kind: NodeKind }>>,
    listServices(sql, range),
  ]);

  const toEdge = (r: EdgeRow, targetKind: NodeKind): DependencyEdge => ({
    source: r.source,
    target: r.target,
    targetKind,
    callCount: r.calls,
    errorCount: r.errors,
    latency: { p50: num(r.p50), p95: num(r.p95), p99: num(r.p99) },
  });
  const edges = [
    ...serviceEdges.map((r) => toEdge(r, 'service')),
    ...externalEdges.map((r) => toEdge(r, r.kind)),
  ].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  const nodes = new Map<string, DependencyNode>();
  for (const s of services) {
    nodes.set(s.name, {
      id: s.name,
      kind: 'service',
      requestCount: s.requestCount,
      errorCount: s.errorCount,
      errorRate: s.errorRate,
      latency: s.latency,
    });
  }
  for (const e of edges) {
    if (e.targetKind !== 'service' && !nodes.has(e.target)) {
      // External systems: aggregate the edges pointing at them.
      const incoming = edges.filter((x) => x.target === e.target);
      const calls = incoming.reduce((sum, x) => sum + x.callCount, 0);
      const errors = incoming.reduce((sum, x) => sum + x.errorCount, 0);
      nodes.set(e.target, {
        id: e.target,
        kind: e.targetKind,
        requestCount: calls,
        errorCount: errors,
        errorRate: ratio(errors, calls),
        latency: incoming.length === 1 ? e.latency : { p50: null, p95: null, p99: null },
      });
    }
  }
  return { window: range.window, nodes: [...nodes.values()], edges };
}

interface EdgeRow {
  source: string;
  target: string;
  calls: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Log-ish latency bucket boundaries in ms (upper bounds are exclusive). */
export const HISTOGRAM_BOUNDS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

export async function getServiceDetail(
  sql: Sql,
  range: WindowRange,
  name: string,
): Promise<ServiceDetail | null> {
  const [summary] = await listServices(sql, range, name);
  if (!summary) return null;

  const [series, histogramRows, operationRows, graph, recent] = await Promise.all([
    timeseries(sql, range, { serviceName: name }),
    sql`
      select width_bucket(s.duration_ms, ${sql.unsafe(`array[${HISTOGRAM_BOUNDS.join(',')}]::float8[]`)}) as b,
        count(*)::int as count
      from spans s join services sv on sv.id = s.service_id
      where sv.name = ${name} and s.start_time >= ${range.from} and (${sql.unsafe(ENTRY_SPAN)})
      group by b
    ` as unknown as Promise<Array<{ b: number; count: number }>>,
    sql`
      select s.operation_name as name, s.kind,
        count(*)::int as count,
        (count(*) filter (where s.is_error))::int as errors,
        percentile_cont(0.5) within group (order by s.duration_ms) as p50,
        percentile_cont(0.95) within group (order by s.duration_ms) as p95,
        percentile_cont(0.99) within group (order by s.duration_ms) as p99
      from spans s join services sv on sv.id = s.service_id
      where sv.name = ${name} and s.start_time >= ${range.from}
      group by s.operation_name, s.kind
      order by count(*) desc, s.operation_name
      limit 100
    ` as unknown as Promise<Array<EdgeRow & { name: string; kind: number; count: number }>>,
    getDependencyGraph(sql, range),
    recentTraces(sql, 20, name),
  ]);

  const counts = new Map(histogramRows.map((r) => [r.b, r.count]));
  const histogram: HistogramBucket[] = [0, ...HISTOGRAM_BOUNDS].map((lower, i) => ({
    fromMs: lower,
    toMs: HISTOGRAM_BOUNDS[i] ?? null,
    count: counts.get(i) ?? 0,
  }));

  const operations: OperationSummary[] = operationRows.map((r) => ({
    name: r.name,
    kind: spanKindName(r.kind),
    count: r.count,
    errorCount: r.errors,
    latency: { p50: num(r.p50), p95: num(r.p95), p99: num(r.p99) },
  }));

  return {
    window: range.window,
    service: summary,
    timeseries: series,
    bucketSeconds: range.bucketSeconds,
    histogram,
    operations,
    upstream: graph.edges.filter((e) => e.target === name),
    downstream: graph.edges.filter((e) => e.source === name),
    recentTraces: recent,
  };
}
