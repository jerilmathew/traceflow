import type { Sql } from '@traceflow/db';
import type { Paginated, TraceDetail, TraceSummary } from '@traceflow/shared';
import { toSpanDto, toTraceSummary, type SpanRowRaw, type TraceRowRaw } from '../mappers';

export const TRACE_COLUMNS = `trace_id, root_service, root_operation, root_span_id, start_time, end_time,
  duration_ms, status, span_count, error_count, orphan_count, services, has_root, updated_at`;

export interface TraceSearch {
  q?: string;
  service?: string;
  status?: 'ok' | 'error';
  minDurationMs?: number;
  maxDurationMs?: number;
  from?: Date;
  to?: Date;
  sort: 'startTime' | 'duration' | 'spanCount';
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

const SORT_COLUMNS: Record<TraceSearch['sort'], string> = {
  startTime: 'start_time',
  duration: 'duration_ms',
  spanCount: 'span_count',
};

/** Escape LIKE metacharacters so user input is matched literally. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchTraces(sql: Sql, search: TraceSearch): Promise<Paginated<TraceSummary>> {
  // Every user-provided value below is a bound parameter; only fragments we
  // construct ourselves (and a whitelisted identifier) are spliced in.
  const conditions = [];
  if (search.q) {
    const q = search.q.trim();
    if (/^[0-9a-f]{4,32}$/i.test(q)) {
      // Looks like (part of) a trace id → prefix match on the primary key.
      conditions.push(sql`(trace_id like ${`${escapeLike(q.toLowerCase())}%`} or root_operation ilike ${`%${escapeLike(q)}%`})`);
    } else {
      const pattern = `%${escapeLike(q)}%`;
      conditions.push(sql`(root_operation ilike ${pattern} or root_service ilike ${pattern})`);
    }
  }
  // services @> array[...] can use the GIN index on traces.services.
  if (search.service) conditions.push(sql`services @> array[${search.service}]::text[]`);
  if (search.status) conditions.push(sql`status = ${search.status}`);
  if (search.minDurationMs !== undefined) conditions.push(sql`duration_ms >= ${search.minDurationMs}`);
  if (search.maxDurationMs !== undefined) conditions.push(sql`duration_ms <= ${search.maxDurationMs}`);
  if (search.from) conditions.push(sql`start_time >= ${search.from}`);
  if (search.to) conditions.push(sql`start_time <= ${search.to}`);

  const where = conditions.length
    ? conditions.reduce((acc, cond, i) => (i === 0 ? sql`where ${cond}` : sql`${acc} and ${cond}`), sql``)
    : sql``;
  const column = sql(SORT_COLUMNS[search.sort]);
  const direction = search.order === 'asc' ? sql`asc` : sql`desc`;
  const offset = (search.page - 1) * search.pageSize;

  const [rows, [{ total }]] = (await Promise.all([
    sql`
      select ${sql.unsafe(TRACE_COLUMNS)} from traces ${where}
      order by ${column} ${direction}, trace_id ${direction}
      limit ${search.pageSize} offset ${offset}
    `,
    sql`select count(*)::int as total from traces ${where}`,
  ])) as unknown as [TraceRowRaw[], [{ total: number }]];

  return {
    items: rows.map(toTraceSummary),
    page: search.page,
    pageSize: search.pageSize,
    total,
  };
}

export const MAX_SPANS_PER_TRACE = 10_000;

export async function getTraceDetail(sql: Sql, traceId: string): Promise<TraceDetail | null> {
  const [traceRow] = (await sql`
    select ${sql.unsafe(TRACE_COLUMNS)}, start_unix_nano from traces where trace_id = ${traceId}
  `) as unknown as Array<TraceRowRaw & { start_unix_nano: bigint }>;
  if (!traceRow) return null;

  const spanRows = (await sql`
    select s.trace_id, s.span_id, s.parent_span_id, sv.name as service, s.operation_name, s.kind,
      s.start_unix_nano, s.end_unix_nano, s.duration_ms, s.status_code, s.status_message,
      s.attributes, s.resource_attributes, s.events, s.links, s.scope_name
    from spans s
    join services sv on sv.id = s.service_id
    where s.trace_id = ${traceId}
    order by s.start_unix_nano, s.span_id
    limit ${MAX_SPANS_PER_TRACE + 1}
  `) as unknown as SpanRowRaw[];

  const truncated = spanRows.length > MAX_SPANS_PER_TRACE;
  const traceStart = BigInt(traceRow.start_unix_nano);
  return {
    trace: toTraceSummary(traceRow),
    spans: spanRows.slice(0, MAX_SPANS_PER_TRACE).map((row) => toSpanDto(row, traceStart)),
    truncated,
  };
}

export async function getTraceSummaries(sql: Sql, traceIds: readonly string[]): Promise<TraceSummary[]> {
  if (traceIds.length === 0) return [];
  const rows = (await sql`
    select ${sql.unsafe(TRACE_COLUMNS)} from traces
    where trace_id in (select t::char(32) from jsonb_array_elements_text(${JSON.stringify(traceIds)}::text::jsonb) as t)
    order by start_time desc
  `) as unknown as TraceRowRaw[];
  return rows.map(toTraceSummary);
}

export async function recentTraces(sql: Sql, limit: number, service?: string): Promise<TraceSummary[]> {
  const rows = (await sql`
    select ${sql.unsafe(TRACE_COLUMNS)} from traces
    ${service ? sql`where services @> array[${service}]::text[]` : sql``}
    order by start_time desc limit ${limit}
  `) as unknown as TraceRowRaw[];
  return rows.map(toTraceSummary);
}
