/**
 * OTLP/HTTP JSON trace payload parsing and normalization.
 *
 * Input: the JSON encoding of `ExportTraceServiceRequest` as described in the
 * OTLP specification (https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding).
 *
 * The JSON mapping has several legal spellings that real exporters use, so
 * the parser is lenient about representation and strict about meaning:
 *
 * - trace/span ids: hex strings (what the spec requires for OTLP/JSON) and,
 *   as a compatibility fallback, base64 (the generic proto3 JSON mapping).
 * - 64-bit integers (`timeUnixNano`, `intValue`): decimal strings, numbers,
 *   or `{ low, high }` long-bits objects.
 * - enums (`kind`, `status.code`): integers or their proto names.
 * - field names: lowerCamelCase (canonical) or snake_case.
 *
 * Every span is validated independently. Invalid spans are rejected with a
 * reason while valid spans in the same request are still accepted, which maps
 * onto OTLP's `partialSuccess` response.
 */
import { isValidSpanId, isValidTraceId, type AttributeValue, type Attributes } from '@traceflow/shared';

export const LIMITS = {
  maxSpansPerRequest: 10_000,
  maxAttributesPerSpan: 128,
  maxEventsPerSpan: 128,
  maxLinksPerSpan: 32,
  maxAttributeValueLength: 4_096,
  maxNameLength: 512,
  maxNestingDepth: 8,
} as const;

export const SPAN_KIND = {
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

export const STATUS_CODE = { UNSET: 0, OK: 1, ERROR: 2 } as const;

export interface NormalizedEvent {
  name: string;
  timeUnixNano: string;
  attributes: Attributes;
}

export interface NormalizedLink {
  traceId: string;
  spanId: string;
  attributes: Attributes;
}

export interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  serviceName: string;
  environment: string;
  operationName: string;
  kind: number;
  startUnixNano: bigint;
  endUnixNano: bigint;
  durationMs: number;
  statusCode: number;
  statusMessage: string | null;
  attributes: Attributes;
  resourceAttributes: Attributes;
  events: NormalizedEvent[];
  links: NormalizedLink[];
  scopeName: string | null;
  /** Count of attributes/events/links dropped because of limits. */
  droppedCount: number;
}

export interface RejectedSpan {
  index: number;
  traceId?: string;
  spanId?: string;
  reason: string;
}

export interface ParseResult {
  spans: NormalizedSpan[];
  rejected: RejectedSpan[];
}

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (v: Json): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read a field by its canonical camelCase name or its snake_case alias. */
function field(obj: JsonObject, camel: string): Json {
  if (camel in obj) return obj[camel];
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return obj[snake];
}

function arrayField(obj: JsonObject, camel: string): Json[] {
  const value = field(obj, camel);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PayloadError(`"${camel}" must be an array`);
  return value;
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Normalize a trace/span id to lowercase hex. Returns null for empty ids
 * (which OTLP uses to mean "no parent").
 */
export function normalizeId(value: Json, bytes: 8 | 16): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new PayloadError('id must be a string');
  const hexLength = bytes * 2;
  if (value.length === hexLength && /^[0-9a-fA-F]+$/.test(value)) return value.toLowerCase();
  // base64 of N bytes is ceil(N/3)*4 chars: 16 bytes → 24, 8 bytes → 12.
  if (value.length === Math.ceil(bytes / 3) * 4 && BASE64_RE.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === bytes) return decoded.toString('hex');
  }
  throw new PayloadError(`invalid ${bytes === 16 ? 'trace' : 'span'} id "${value.slice(0, 64)}"`);
}

/** Parse a uint64 encoded as string, number, or {low, high} into a bigint. */
export function parseUint64(value: Json, name: string): bigint {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (isObject(value) && typeof value.low === 'number' && typeof value.high === 'number') {
    return (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
  }
  throw new PayloadError(`"${name}" must be an unsigned 64-bit integer`);
}

const KIND_NAMES: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};

const STATUS_NAMES: Record<string, number> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

function parseEnum(value: Json, names: Record<string, number>, max: number, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max) return value;
  if (typeof value === 'string' && value in names) return names[value]!;
  throw new PayloadError(`invalid ${label} "${String(value).slice(0, 64)}"`);
}

/**
 * Bound string length and strip NUL characters (PostgreSQL text/jsonb cannot
 * store U+0000, so one bad attribute would otherwise fail a whole batch).
 */
function truncate(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const value = raw.includes('\u0000') ? raw.replace(/\u0000/g, '') : raw;
  return value.length > max ? `${value.slice(0, max)}…[truncated ${value.length - max} chars]` : value;
}

// ---------------------------------------------------------------------------
// Attributes (AnyValue / KeyValue)
// ---------------------------------------------------------------------------

/** Convert an OTLP AnyValue into a plain JSON value. */
export function parseAnyValue(value: Json, depth = 0): AttributeValue {
  if (!isObject(value)) return null;
  if (depth > LIMITS.maxNestingDepth) return '[max nesting depth exceeded]';
  const str = field(value, 'stringValue');
  if (str !== undefined) return truncate(String(str), LIMITS.maxAttributeValueLength);
  const bool = field(value, 'boolValue');
  if (bool !== undefined) return Boolean(bool);
  const int = field(value, 'intValue');
  if (int !== undefined) {
    // int64 may exceed Number.MAX_SAFE_INTEGER; keep exact digits as a string in that case.
    const asNumber = Number(int);
    if (Number.isSafeInteger(asNumber)) return asNumber;
    return String(int);
  }
  const dbl = field(value, 'doubleValue');
  if (dbl !== undefined) {
    const n = Number(dbl);
    // JSON cannot represent NaN/Infinity; OTLP/JSON encodes them as strings.
    return Number.isFinite(n) ? n : String(dbl);
  }
  const arr = field(value, 'arrayValue');
  if (arr !== undefined) {
    const values = isObject(arr) && Array.isArray(arr.values) ? arr.values : [];
    return values.slice(0, LIMITS.maxAttributesPerSpan).map((v) => parseAnyValue(v, depth + 1));
  }
  const kv = field(value, 'kvlistValue');
  if (kv !== undefined) {
    const values = isObject(kv) && Array.isArray(kv.values) ? kv.values : [];
    return parseKeyValues(values, depth + 1).attributes;
  }
  const bytes = field(value, 'bytesValue');
  if (bytes !== undefined) return truncate(`base64:${String(bytes)}`, LIMITS.maxAttributeValueLength);
  return null;
}

/** Keys that could pollute Object.prototype when assigned with `obj[key] = …`. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parseKeyValues(list: Json[], depth = 0): { attributes: Attributes; dropped: number } {
  const attributes: Attributes = Object.create(null) as Attributes;
  let dropped = 0;
  for (const item of list) {
    if (!isObject(item) || typeof item.key !== 'string' || item.key === '') {
      dropped++;
      continue;
    }
    if (UNSAFE_KEYS.has(item.key)) {
      dropped++;
      continue;
    }
    if (Object.keys(attributes).length >= LIMITS.maxAttributesPerSpan) {
      dropped++;
      continue;
    }
    attributes[truncate(item.key, 256)] = parseAnyValue(item.value, depth);
  }
  // Return a normal object so JSON serialization / equality checks behave as usual.
  return { attributes: { ...attributes }, dropped };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function nanosToMs(start: bigint, end: bigint): number {
  // Keep sub-millisecond precision without going through lossy Number(nanos).
  const delta = end - start;
  return Number(delta / 1000n) / 1000 + Number(delta % 1000n) / 1_000_000;
}

function stringAttr(attrs: Attributes, key: string): string | null {
  const value = attrs[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function parseExportTraceServiceRequest(body: Json): ParseResult {
  if (!isObject(body)) throw new PayloadError('request body must be a JSON object');
  const resourceSpans = arrayField(body, 'resourceSpans');

  const spans: NormalizedSpan[] = [];
  const rejected: RejectedSpan[] = [];
  let index = 0;

  for (const rs of resourceSpans) {
    if (!isObject(rs)) throw new PayloadError('resourceSpans entries must be objects');
    const resource = field(rs, 'resource');
    const { attributes: resourceAttributes } = parseKeyValues(
      isObject(resource) ? arrayField(resource, 'attributes') : [],
    );
    // The OTel SDK always sets service.name (falling back to "unknown_service:<process>").
    const serviceName = truncate(stringAttr(resourceAttributes, 'service.name') ?? 'unknown_service', 256);
    const environment = truncate(
      stringAttr(resourceAttributes, 'deployment.environment.name') ??
        stringAttr(resourceAttributes, 'deployment.environment') ??
        '',
      128,
    );

    for (const ss of arrayField(rs, 'scopeSpans')) {
      if (!isObject(ss)) throw new PayloadError('scopeSpans entries must be objects');
      const scope = field(ss, 'scope');
      const scopeName = isObject(scope) && typeof scope.name === 'string' ? truncate(scope.name, 256) : null;

      for (const raw of arrayField(ss, 'spans')) {
        const currentIndex = index++;
        if (currentIndex >= LIMITS.maxSpansPerRequest) {
          throw new PayloadError(
            `request contains more than ${LIMITS.maxSpansPerRequest} spans; split it into smaller batches`,
          );
        }
        try {
          spans.push(
            normalizeSpan(raw, { serviceName, environment, resourceAttributes, scopeName }),
          );
        } catch (error) {
          if (!(error instanceof PayloadError)) throw error;
          const ids = isObject(raw)
            ? { traceId: safeString(field(raw, 'traceId')), spanId: safeString(field(raw, 'spanId')) }
            : {};
          rejected.push({ index: currentIndex, ...ids, reason: error.message });
        }
      }
    }
  }
  return { spans, rejected };
}

function safeString(value: Json): string | undefined {
  return typeof value === 'string' ? value.slice(0, 64) : undefined;
}

interface ResourceContext {
  serviceName: string;
  environment: string;
  resourceAttributes: Attributes;
  scopeName: string | null;
}

export function normalizeSpan(raw: Json, ctx: ResourceContext): NormalizedSpan {
  if (!isObject(raw)) throw new PayloadError('span must be an object');

  const traceId = normalizeId(field(raw, 'traceId'), 16);
  const spanId = normalizeId(field(raw, 'spanId'), 8);
  if (!traceId || !isValidTraceId(traceId)) throw new PayloadError('missing or invalid traceId');
  if (!spanId || !isValidSpanId(spanId)) throw new PayloadError('missing or invalid spanId');
  let parentSpanId = normalizeId(field(raw, 'parentSpanId'), 8);
  // An all-zero parent id is how some exporters spell "no parent".
  if (parentSpanId !== null && !isValidSpanId(parentSpanId)) parentSpanId = null;
  if (parentSpanId === spanId) throw new PayloadError('span cannot be its own parent');

  const name = field(raw, 'name');
  if (typeof name !== 'string' || name.trim() === '') throw new PayloadError('span name is required');

  const start = parseUint64(field(raw, 'startTimeUnixNano'), 'startTimeUnixNano');
  const end = parseUint64(field(raw, 'endTimeUnixNano'), 'endTimeUnixNano');
  if (start === 0n) throw new PayloadError('startTimeUnixNano must be set');
  if (end < start) throw new PayloadError('endTimeUnixNano is before startTimeUnixNano');
  // Postgres bigint is signed 64-bit; also reject absurd timestamps (> year 2262).
  if (end > 9_223_372_036_854_775_807n) throw new PayloadError('timestamp out of range');

  const kind = parseEnum(field(raw, 'kind'), KIND_NAMES, 5, 'span kind');
  const status = field(raw, 'status');
  const statusCode = isObject(status)
    ? parseEnum(field(status, 'code'), STATUS_NAMES, 2, 'status code')
    : STATUS_CODE.UNSET;
  const statusMessage =
    isObject(status) && typeof status.message === 'string' && status.message !== ''
      ? truncate(status.message, LIMITS.maxAttributeValueLength)
      : null;

  const { attributes, dropped: droppedAttrs } = parseKeyValues(arrayField(raw, 'attributes'));

  let dropped = droppedAttrs;
  const rawEvents = arrayField(raw, 'events');
  const events: NormalizedEvent[] = [];
  for (const ev of rawEvents.slice(0, LIMITS.maxEventsPerSpan)) {
    if (!isObject(ev)) {
      dropped++;
      continue;
    }
    const evTime = parseUint64(field(ev, 'timeUnixNano') ?? '0', 'event timeUnixNano');
    events.push({
      name: truncate(typeof ev.name === 'string' ? ev.name : '(unnamed event)', LIMITS.maxNameLength),
      timeUnixNano: evTime.toString(),
      attributes: parseKeyValues(arrayField(ev, 'attributes')).attributes,
    });
  }
  dropped += Math.max(0, rawEvents.length - LIMITS.maxEventsPerSpan);

  const rawLinks = arrayField(raw, 'links');
  const links: NormalizedLink[] = [];
  for (const link of rawLinks.slice(0, LIMITS.maxLinksPerSpan)) {
    try {
      if (!isObject(link)) throw new PayloadError('link must be an object');
      const linkTrace = normalizeId(field(link, 'traceId'), 16);
      const linkSpan = normalizeId(field(link, 'spanId'), 8);
      if (!linkTrace || !linkSpan) throw new PayloadError('link ids are required');
      links.push({
        traceId: linkTrace,
        spanId: linkSpan,
        attributes: parseKeyValues(arrayField(link, 'attributes')).attributes,
      });
    } catch {
      dropped++;
    }
  }
  dropped += Math.max(0, rawLinks.length - LIMITS.maxLinksPerSpan);

  return {
    traceId,
    spanId,
    parentSpanId,
    serviceName: ctx.serviceName,
    environment: ctx.environment,
    operationName: truncate(name, LIMITS.maxNameLength),
    kind,
    startUnixNano: start,
    endUnixNano: end,
    durationMs: nanosToMs(start, end),
    statusCode,
    statusMessage,
    attributes,
    resourceAttributes: ctx.resourceAttributes,
    events,
    links,
    scopeName: ctx.scopeName,
    droppedCount: dropped,
  };
}

/**
 * Error classification. OTel semantics: a span is an error iff its status code
 * is ERROR. We additionally treat spans with an `exception` event *and* unset
 * status as errors only when the instrumentation recorded the exception as
 * escaping (`exception.escaped = true`), mirroring how most backends read it.
 */
export function isErrorSpan(span: Pick<NormalizedSpan, 'statusCode' | 'events'>): boolean {
  if (span.statusCode === STATUS_CODE.ERROR) return true;
  if (span.statusCode === STATUS_CODE.OK) return false;
  return span.events.some(
    (e) => e.name === 'exception' && e.attributes['exception.escaped'] === true,
  );
}
