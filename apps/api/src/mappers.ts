import type { Attributes, SpanDto, SpanKind, SpanStatusCode, TraceSummary } from '@traceflow/shared';

const KINDS: SpanKind[] = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
const STATUSES: SpanStatusCode[] = ['unset', 'ok', 'error'];

export const spanKindName = (kind: number): SpanKind => KINDS[kind] ?? 'unspecified';
export const statusName = (code: number): SpanStatusCode => STATUSES[code] ?? 'unset';

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export interface TraceRowRaw {
  trace_id: string;
  root_service: string | null;
  root_operation: string | null;
  root_span_id: string | null;
  start_time: Date;
  end_time: Date;
  duration_ms: number;
  status: string;
  span_count: number;
  error_count: number;
  orphan_count: number;
  services: string[] | string;
  has_root: boolean;
  updated_at: Date;
}

/** postgres.js returns text[] as an array, but fall back to parsing the literal just in case. */
function parseTextArray(value: string[] | string): string[] {
  if (Array.isArray(value)) return value;
  const inner = value.replace(/^\{|\}$/g, '');
  return inner === '' ? [] : inner.split(',').map((s) => s.replace(/^"|"$/g, ''));
}

export function toTraceSummary(row: TraceRowRaw): TraceSummary {
  return {
    traceId: row.trace_id,
    rootService: row.root_service,
    rootOperation: row.root_operation,
    rootSpanId: row.root_span_id,
    startTime: iso(row.start_time),
    endTime: iso(row.end_time),
    durationMs: Number(row.duration_ms),
    status: row.status === 'error' ? 'error' : 'ok',
    spanCount: row.span_count,
    errorCount: row.error_count,
    services: parseTextArray(row.services),
    hasRoot: row.has_root,
    orphanCount: row.orphan_count,
    updatedAt: iso(row.updated_at),
  };
}

export interface SpanRowRaw {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service: string;
  operation_name: string;
  kind: number;
  start_unix_nano: bigint;
  end_unix_nano: bigint;
  duration_ms: number;
  status_code: number;
  status_message: string | null;
  attributes: Attributes;
  resource_attributes: Attributes;
  events: Array<{ name: string; timeUnixNano: string; attributes: Attributes }>;
  links: Array<{ traceId: string; spanId: string; attributes: Attributes }>;
  scope_name: string | null;
}

/** Exact nanosecond difference → milliseconds, without passing 1e18-sized values through floats. */
export function nanosDiffMs(a: bigint, b: bigint): number {
  const delta = a - b;
  return Number(delta / 1000n) / 1000 + Number(delta % 1000n) / 1e6;
}

export function toSpanDto(row: SpanRowRaw, traceStart: bigint): SpanDto {
  const start = BigInt(row.start_unix_nano);
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    service: row.service,
    operationName: row.operation_name,
    kind: spanKindName(row.kind),
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: BigInt(row.end_unix_nano).toString(),
    offsetMs: nanosDiffMs(start, traceStart),
    durationMs: Number(row.duration_ms),
    statusCode: statusName(row.status_code),
    statusMessage: row.status_message,
    attributes: row.attributes ?? {},
    resourceAttributes: row.resource_attributes ?? {},
    events: (row.events ?? []).map((e) => {
      let offsetMs = 0;
      try {
        offsetMs = e.timeUnixNano && e.timeUnixNano !== '0' ? nanosDiffMs(BigInt(e.timeUnixNano), traceStart) : 0;
      } catch {
        offsetMs = 0;
      }
      return { name: e.name, timeUnixNano: e.timeUnixNano, offsetMs, attributes: e.attributes ?? {} };
    }),
    links: row.links ?? [],
    scopeName: row.scope_name,
  };
}
