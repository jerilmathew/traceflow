import { randomBytes } from 'node:crypto';

/** Helpers to build OTLP/HTTP JSON payloads in tests. */

export const randomTraceId = () => randomBytes(16).toString('hex');
export const randomSpanId = () => randomBytes(8).toString('hex');

export interface TestSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** OTLP kind: 1 internal, 2 server, 3 client. */
  kind?: number;
  /** Start offset in ms relative to `base`. */
  startMs: number;
  durationMs: number;
  statusCode?: 0 | 1 | 2;
  statusMessage?: string;
  attributes?: Record<string, string | number | boolean>;
  events?: Array<{
    name: string;
    atMs: number;
    attributes?: Record<string, string | number | boolean>;
  }>;
}

/** Fixed base time well inside any query window: "now" minus 1 minute, at ms precision. */
export const BASE_NS = BigInt(Date.now() - 60_000) * 1_000_000n;

const toNs = (ms: number) => (BASE_NS + BigInt(Math.round(ms * 1_000_000))).toString();

function anyValue(v: string | number | boolean) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

const kvs = (attrs: Record<string, string | number | boolean> = {}) =>
  Object.entries(attrs).map(([key, v]) => ({ key, value: anyValue(v) }));

export function otlpSpan(s: TestSpan) {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: s.kind ?? 1,
    startTimeUnixNano: toNs(s.startMs),
    endTimeUnixNano: toNs(s.startMs + s.durationMs),
    attributes: kvs(s.attributes),
    events: (s.events ?? []).map((e) => ({
      name: e.name,
      timeUnixNano: toNs(e.atMs),
      attributes: kvs(e.attributes),
    })),
    status: { code: s.statusCode ?? 0, ...(s.statusMessage ? { message: s.statusMessage } : {}) },
  };
}

/** Build an ExportTraceServiceRequest; `groups` maps service name → spans. */
export function otlpPayload(groups: Record<string, TestSpan[]>, environment = 'test') {
  return {
    resourceSpans: Object.entries(groups).map(([service, spans]) => ({
      resource: {
        attributes: kvs({ 'service.name': service, 'deployment.environment.name': environment }),
      },
      scopeSpans: [{ scope: { name: 'traceflow-tests' }, spans: spans.map(otlpSpan) }],
    })),
  };
}
