/**
 * API contracts shared by the TraceFlow API and the web dashboard.
 *
 * All timestamps that cross the wire are ISO-8601 strings, except raw
 * OpenTelemetry nanosecond timestamps which are decimal *strings*: a Unix
 * nanosecond timestamp (~1.7e18) does not fit in a JavaScript number without
 * losing precision. Relative offsets inside a trace are plain millisecond
 * floats, computed server-side from the exact integer values.
 */

export type AttributeValue =
  string | number | boolean | null | AttributeValue[] | { [key: string]: AttributeValue };

export type Attributes = Record<string, AttributeValue>;

export type SpanKind = 'unspecified' | 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatusCode = 'unset' | 'ok' | 'error';
export type TraceStatus = 'ok' | 'error';

export interface TraceSummary {
  traceId: string;
  /** Service of the root span, or of the earliest span if the root is missing. */
  rootService: string | null;
  rootOperation: string | null;
  rootSpanId: string | null;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: TraceStatus;
  spanCount: number;
  errorCount: number;
  services: string[];
  /** True once a span with no parent (the true root) has been received. */
  hasRoot: boolean;
  /** Number of spans whose parent span has not (yet) been received. */
  orphanCount: number;
  updatedAt: string;
}

export interface SpanEventDto {
  name: string;
  timeUnixNano: string;
  /** Milliseconds since the start of the trace. */
  offsetMs: number;
  attributes: Attributes;
}

export interface SpanLinkDto {
  traceId: string;
  spanId: string;
  attributes: Attributes;
}

export interface SpanDto {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  service: string;
  operationName: string;
  kind: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  /** Milliseconds between the start of the trace and the start of this span. */
  offsetMs: number;
  durationMs: number;
  statusCode: SpanStatusCode;
  statusMessage: string | null;
  attributes: Attributes;
  resourceAttributes: Attributes;
  events: SpanEventDto[];
  links: SpanLinkDto[];
  scopeName: string | null;
}

export interface TraceDetail {
  trace: TraceSummary;
  spans: SpanDto[];
  /** True when the trace exceeded the API's span limit and was cut off. */
  truncated: boolean;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface LatencyPercentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface TimeBucket {
  /** ISO start of the bucket. */
  ts: string;
  count: number;
  errors: number;
  p95: number | null;
}

export type TimeWindow = '15m' | '1h' | '6h' | '24h' | '7d';

export interface Overview {
  window: TimeWindow;
  from: string;
  to: string;
  traceCount: number;
  spanCount: number;
  errorTraceCount: number;
  /** errorTraceCount / traceCount, 0..1. Null when there were no traces. */
  errorRate: number | null;
  /** Traces per second, averaged over the window. */
  requestRate: number;
  latency: LatencyPercentiles;
  serviceCount: number;
  timeseries: TimeBucket[];
  bucketSeconds: number;
  slowestServices: ServiceSummary[];
  recentTraces: TraceSummary[];
}

export interface ServiceSummary {
  name: string;
  environment: string | null;
  /** Count of entry spans (server/consumer/root spans) in the window. */
  requestCount: number;
  errorCount: number;
  errorRate: number | null;
  requestRate: number;
  latency: LatencyPercentiles;
  lastSeen: string | null;
}

export interface OperationSummary {
  name: string;
  kind: SpanKind;
  count: number;
  errorCount: number;
  latency: LatencyPercentiles;
}

export interface HistogramBucket {
  /** Inclusive lower bound in ms. */
  fromMs: number;
  /** Exclusive upper bound in ms; null for the overflow bucket. */
  toMs: number | null;
  count: number;
}

export interface DependencyEdge {
  source: string;
  target: string;
  /** 'service' when the callee reported its own spans, otherwise inferred from client-span attributes. */
  targetKind: NodeKind;
  callCount: number;
  errorCount: number;
  latency: LatencyPercentiles;
}

export type NodeKind = 'service' | 'database' | 'messaging';

export interface DependencyNode {
  id: string;
  kind: NodeKind;
  requestCount: number;
  errorCount: number;
  errorRate: number | null;
  latency: LatencyPercentiles;
}

export interface DependencyGraph {
  window: TimeWindow;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface ServiceDetail {
  window: TimeWindow;
  service: ServiceSummary;
  timeseries: TimeBucket[];
  bucketSeconds: number;
  histogram: HistogramBucket[];
  operations: OperationSummary[];
  upstream: DependencyEdge[];
  downstream: DependencyEdge[];
  recentTraces: TraceSummary[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Server-Sent Event payload pushed when new spans are ingested. */
export interface LiveTracesEvent {
  traces: TraceSummary[];
}

/** Present when the instance is a public demo; null otherwise. */
export interface DemoInfo {
  retentionHours: number;
  sourceUrl: string | null;
}
