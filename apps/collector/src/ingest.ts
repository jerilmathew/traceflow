/**
 * Persisting normalized spans and maintaining trace summaries.
 *
 * Design notes (see docs/ARCHITECTURE.md for the long version):
 *
 * 1. Idempotency. `(trace_id, span_id)` is the primary key of `spans` and
 *    inserts use `ON CONFLICT DO NOTHING`. OTLP exporters retry whole batches
 *    on timeouts/5xx, so the same span can legitimately arrive several times;
 *    re-ingesting it is a no-op and is reported as a duplicate.
 *
 * 2. Order independence. Spans of one trace arrive from different processes,
 *    in different batches, in any order — a child is usually exported *before*
 *    its parent because it ends first. We therefore never build summaries
 *    incrementally from the incoming batch. Instead, after inserting, the
 *    summary row of every affected trace is recomputed from *all* of that
 *    trace's stored spans. The result depends only on the set of spans, never
 *    on arrival order.
 *
 * 3. Concurrency. Two collector requests can carry spans of the same trace at
 *    the same time. Under READ COMMITTED, transaction B's recompute could miss
 *    A's not-yet-committed spans and overwrite a newer summary with a stale
 *    one. A transaction-scoped advisory lock per trace id serialises
 *    insert+recompute for the same trace (locks are taken in sorted order so
 *    two batches can never deadlock). Different traces never contend.
 *
 * 4. Live updates. `pg_notify` is issued inside the transaction; PostgreSQL
 *    only delivers it if the transaction commits, so subscribers never hear
 *    about data they cannot read yet.
 */
import type { Sql } from '@traceflow/db';
import { isErrorSpan, type NormalizedSpan } from './otlp/parse';

export const NOTIFY_CHANNEL = 'traceflow_ingest';
/** NOTIFY payloads are limited to 8000 bytes; 32 hex ids + quotes ≈ 35 bytes each. */
const MAX_NOTIFY_TRACE_IDS = 150;

export interface IngestResult {
  receivedSpans: number;
  acceptedSpans: number;
  duplicateSpans: number;
  traceIds: string[];
}

export async function ingestSpans(sql: Sql, spans: readonly NormalizedSpan[]): Promise<IngestResult> {
  // De-duplicate within the batch first; the database handles cross-batch duplicates.
  const unique = new Map<string, NormalizedSpan>();
  for (const span of spans) {
    const key = `${span.traceId}:${span.spanId}`;
    if (!unique.has(key)) unique.set(key, span);
  }
  const batch = [...unique.values()];
  if (batch.length === 0) {
    return { receivedSpans: spans.length, acceptedSpans: 0, duplicateSpans: spans.length, traceIds: [] };
  }

  const traceIds = [...new Set(batch.map((s) => s.traceId))].sort();
  const serviceKeys = new Map<string, { name: string; environment: string }>();
  for (const s of batch) serviceKeys.set(`${s.serviceName}\u0000${s.environment}`, { name: s.serviceName, environment: s.environment });

  const rows = batch.map((s) => ({
    trace_id: s.traceId,
    span_id: s.spanId,
    parent_span_id: s.parentSpanId,
    service_name: s.serviceName,
    environment: s.environment,
    operation_name: s.operationName,
    kind: s.kind,
    start_unix_nano: s.startUnixNano.toString(),
    end_unix_nano: s.endUnixNano.toString(),
    duration_ms: s.durationMs,
    status_code: s.statusCode,
    status_message: s.statusMessage,
    is_error: isErrorSpan(s),
    attributes: s.attributes,
    resource_attributes: s.resourceAttributes,
    events: s.events,
    links: s.links,
    scope_name: s.scopeName,
  }));

  const inserted = await sql.begin(async (tx) => {
    const services = [...serviceKeys.values()];
    await tx`
      insert into services (name, environment)
      select x.name, x.environment
      from jsonb_to_recordset(${JSON.stringify(services)}::text::jsonb) as x(name text, environment text)
      on conflict (name, environment) do update set last_seen_at = now()
    `;

    // Serialise work per trace (see note 3). Ordered to rule out deadlocks.
    await tx`
      select pg_advisory_xact_lock(k)
      from (select distinct hashtextextended(t, 7411) as k from jsonb_array_elements_text(${JSON.stringify(traceIds)}::text::jsonb) as t order by k) as locks
    `;

    // One statement, one JSON parameter: avoids the 65,535 bind-parameter
    // limit for big batches and resolves service ids in the same round trip.
    const insertedRows = await tx`
      insert into spans (
        trace_id, span_id, parent_span_id, service_id, operation_name, kind,
        start_time, start_unix_nano, end_unix_nano, duration_ms,
        status_code, status_message, is_error,
        attributes, resource_attributes, events, links, scope_name
      )
      select
        x.trace_id, x.span_id, x.parent_span_id, sv.id, x.operation_name, x.kind,
        timestamptz 'epoch' + (x.start_unix_nano::bigint / 1000) * interval '1 microsecond',
        x.start_unix_nano::bigint, x.end_unix_nano::bigint, x.duration_ms,
        x.status_code, x.status_message, x.is_error,
        coalesce(x.attributes, '{}'), coalesce(x.resource_attributes, '{}'),
        coalesce(x.events, '[]'), coalesce(x.links, '[]'), x.scope_name
      from jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) as x(
        trace_id text, span_id text, parent_span_id text, service_name text, environment text,
        operation_name text, kind smallint, start_unix_nano text, end_unix_nano text,
        duration_ms float8, status_code smallint, status_message text, is_error boolean,
        attributes jsonb, resource_attributes jsonb, events jsonb, links jsonb, scope_name text
      )
      join services sv on sv.name = x.service_name and sv.environment = x.environment
      on conflict (trace_id, span_id) do nothing
      returning trace_id
    `;

    await recomputeTraceSummaries(tx as unknown as Sql, traceIds);

    const payload = JSON.stringify({
      traceIds: traceIds.slice(0, MAX_NOTIFY_TRACE_IDS),
      truncated: traceIds.length > MAX_NOTIFY_TRACE_IDS,
    });
    await tx`select pg_notify(${NOTIFY_CHANNEL}, ${payload})`;
    return insertedRows.length;
  });

  return {
    receivedSpans: spans.length,
    acceptedSpans: inserted,
    duplicateSpans: spans.length - inserted,
    traceIds,
  };
}

/**
 * Rebuild `traces` rows for the given trace ids from their stored spans.
 *
 * Root selection: a span without a parent is the true root. Until it arrives
 * (or if it never does), the earliest *orphan* — a span whose parent is not
 * stored — stands in so the trace still has a meaningful name in the list;
 * `has_root = false` marks the trace as incomplete.
 */
export async function recomputeTraceSummaries(sql: Sql, traceIds: readonly string[]): Promise<void> {
  if (traceIds.length === 0) return;
  await sql`
    with affected as (
      select distinct t::char(32) as trace_id
      from jsonb_array_elements_text(${JSON.stringify(traceIds)}::text::jsonb) as t
    ),
    s as (
      select sp.*, sv.name as service_name,
        (sp.parent_span_id is not null and not exists (
          select 1 from spans p where p.trace_id = sp.trace_id and p.span_id = sp.parent_span_id
        )) as is_orphan
      from spans sp
      join services sv on sv.id = sp.service_id
      where sp.trace_id in (select trace_id from affected)
    ),
    agg as (
      select trace_id,
        min(start_unix_nano) as start_ns,
        max(end_unix_nano) as end_ns,
        count(*)::int as span_count,
        (count(*) filter (where is_error))::int as error_count,
        (count(*) filter (where is_orphan))::int as orphan_count,
        array_agg(distinct service_name order by service_name) as services
      from s group by trace_id
    ),
    root as (
      select distinct on (trace_id)
        trace_id, span_id, service_id, service_name, operation_name,
        (parent_span_id is null) as is_root
      from s
      where parent_span_id is null or is_orphan
      order by trace_id, (parent_span_id is null) desc, start_unix_nano asc, duration_ms desc, span_id
    )
    insert into traces (
      trace_id, root_service_id, root_service, root_operation, root_span_id, has_root,
      start_time, end_time, start_unix_nano, end_unix_nano, duration_ms,
      status, span_count, error_count, orphan_count, services, updated_at
    )
    select
      a.trace_id, r.service_id, r.service_name, r.operation_name, r.span_id, coalesce(r.is_root, false),
      timestamptz 'epoch' + (a.start_ns / 1000) * interval '1 microsecond',
      timestamptz 'epoch' + (a.end_ns / 1000) * interval '1 microsecond',
      a.start_ns, a.end_ns, (a.end_ns - a.start_ns)::float8 / 1e6,
      case when a.error_count > 0 then 'error' else 'ok' end,
      a.span_count, a.error_count, a.orphan_count, a.services, now()
    from agg a
    left join root r on r.trace_id = a.trace_id
    on conflict (trace_id) do update set
      root_service_id = excluded.root_service_id,
      root_service = excluded.root_service,
      root_operation = excluded.root_operation,
      root_span_id = excluded.root_span_id,
      has_root = excluded.has_root,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      start_unix_nano = excluded.start_unix_nano,
      end_unix_nano = excluded.end_unix_nano,
      duration_ms = excluded.duration_ms,
      status = excluded.status,
      span_count = excluded.span_count,
      error_count = excluded.error_count,
      orphan_count = excluded.orphan_count,
      services = excluded.services,
      updated_at = now()
  `;
}
