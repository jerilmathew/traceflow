import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  PayloadError,
  isErrorSpan,
  normalizeId,
  parseAnyValue,
  parseExportTraceServiceRequest,
  parseUint64,
} from '../../src/otlp/parse';
import { otlpPayload, randomSpanId, randomTraceId } from '../helpers';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/otel-js-export.json', import.meta.url), 'utf8'),
) as unknown;

describe('parseExportTraceServiceRequest — real OpenTelemetry JS exporter payload', () => {
  const { spans, rejected } = parseExportTraceServiceRequest(fixture);

  it('accepts every span the SDK exported', () => {
    expect(rejected).toEqual([]);
    expect(spans).toHaveLength(2);
  });

  it('extracts service/environment from resource attributes', () => {
    for (const span of spans) {
      expect(span.serviceName).toBe('fixture-service');
      expect(span.environment).toBe('test');
      expect(span.scopeName).toBe('fixture');
    }
  });

  it('preserves ids and parent-child linkage (child exported before parent)', () => {
    const [child, root] = spans;
    expect(child!.traceId).toBe(root!.traceId);
    expect(child!.parentSpanId).toBe(root!.spanId);
    expect(root!.parentSpanId).toBeNull();
    expect(root!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('maps OTLP kinds and status codes', () => {
    const [child, root] = spans;
    expect(root!.kind).toBe(2); // SERVER
    expect(child!.kind).toBe(4); // PRODUCER
    expect(child!.statusCode).toBe(2);
    expect(child!.statusMessage).toBe('connection reset');
    expect(isErrorSpan(child!)).toBe(true);
    expect(isErrorSpan(root!)).toBe(false);
  });

  it('computes exact sub-millisecond durations from nanosecond timestamps', () => {
    const [child] = spans;
    // 1795140782186066375 - 1795140782173000000 = 13_066_375 ns
    expect(child!.durationMs).toBe(13.066375);
    expect(child!.startUnixNano).toBe(1795140782173000000n);
  });

  it('converts typed attribute values', () => {
    const root = spans[1]!;
    expect(root.attributes).toEqual({
      'http.route': '/orders/:id',
      'retry.count': 3,
      'cache.hit': false,
      ratio: 0.25,
      tags: ['a', 'b'],
    });
    expect(root.events[0]).toMatchObject({ name: 'cache.miss', attributes: { key: 'order:42' } });
    expect(spans[0]!.events[0]!.attributes['exception.message']).toBe('connection reset');
  });
});

describe('id normalization', () => {
  it('lowercases hex ids', () => {
    expect(normalizeId('4BF92F3577B34DA6A3CE929D0E0E4736', 16)).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    );
  });

  it('accepts base64-encoded ids (proto3 JSON mapping)', () => {
    const hex = '4bf92f3577b34da6a3ce929d0e0e4736';
    const b64 = Buffer.from(hex, 'hex').toString('base64');
    expect(b64).toHaveLength(24);
    expect(normalizeId(b64, 16)).toBe(hex);
    expect(normalizeId(Buffer.from('00f067aa0ba902b7', 'hex').toString('base64'), 8)).toBe(
      '00f067aa0ba902b7',
    );
  });

  it('treats empty ids as absent and rejects garbage', () => {
    expect(normalizeId('', 8)).toBeNull();
    expect(normalizeId(undefined, 8)).toBeNull();
    expect(() => normalizeId('xyz', 8)).toThrow(PayloadError);
    expect(() => normalizeId(123, 16)).toThrow(PayloadError);
  });
});

describe('uint64 parsing', () => {
  it('accepts decimal strings, safe numbers and {low, high} long bits', () => {
    expect(parseUint64('1795140782173000000', 't')).toBe(1795140782173000000n);
    expect(parseUint64(42, 't')).toBe(42n);
    const value = 1795140782173000000n;
    expect(parseUint64({ low: Number(value & 0xffffffffn), high: Number(value >> 32n) }, 't')).toBe(
      value,
    );
  });

  it('rejects negatives, floats and junk', () => {
    expect(() => parseUint64(-1, 't')).toThrow(PayloadError);
    expect(() => parseUint64(1.5, 't')).toThrow(PayloadError);
    expect(() => parseUint64('12abc', 't')).toThrow(PayloadError);
  });
});

describe('attribute values', () => {
  it('keeps int64 beyond Number.MAX_SAFE_INTEGER exact as a string', () => {
    expect(parseAnyValue({ intValue: '9223372036854775807' })).toBe('9223372036854775807');
    expect(parseAnyValue({ intValue: '12' })).toBe(12);
  });

  it('flattens kvlist values and nested arrays', () => {
    expect(
      parseAnyValue({
        kvlistValue: {
          values: [
            { key: 'a', value: { arrayValue: { values: [{ intValue: 1 }, { boolValue: true }] } } },
          ],
        },
      }),
    ).toEqual({ a: [1, true] });
  });

  it('strips NUL characters and truncates huge strings', () => {
    expect(parseAnyValue({ stringValue: 'a\u0000b' })).toBe('ab');
    const long = parseAnyValue({
      stringValue: 'x'.repeat(LIMITS.maxAttributeValueLength + 100),
    }) as string;
    expect(long.startsWith('x'.repeat(LIMITS.maxAttributeValueLength))).toBe(true);
    expect(long).toContain('[truncated 100 chars]');
  });

  it('represents non-finite doubles as strings (JSON cannot hold NaN)', () => {
    expect(parseAnyValue({ doubleValue: 'NaN' })).toBe('NaN');
  });
});

describe('validation and partial success', () => {
  const traceId = randomTraceId();

  it('rejects invalid spans individually and keeps the valid ones', () => {
    const good = { traceId, spanId: randomSpanId(), name: 'ok', startMs: 0, durationMs: 1 };
    const payload = otlpPayload({ svc: [good] });
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans as Array<Record<string, unknown>>;
    spans.push({ ...spans[0]!, spanId: 'not-hex' });
    spans.push({ ...spans[0]!, spanId: randomSpanId(), endTimeUnixNano: '1' });
    spans.push({ ...spans[0]!, spanId: randomSpanId(), name: '' });
    spans.push({ ...spans[0]!, spanId: '0000000000000000' });

    const result = parseExportTraceServiceRequest(payload);
    expect(result.spans).toHaveLength(1);
    expect(result.rejected.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect(result.rejected[0]!.reason).toMatch(/invalid span id/);
    expect(result.rejected[1]!.reason).toMatch(/before startTimeUnixNano/);
    expect(result.rejected[2]!.reason).toMatch(/name is required/);
  });

  it('accepts snake_case field names and enum names', () => {
    const result = parseExportTraceServiceRequest({
      resource_spans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { string_value: 'snake' } }] },
          scope_spans: [
            {
              spans: [
                {
                  trace_id: traceId,
                  span_id: randomSpanId(),
                  parent_span_id: '0000000000000000',
                  name: 'x',
                  kind: 'SPAN_KIND_CLIENT',
                  start_time_unix_nano: '1000000000',
                  end_time_unix_nano: '3000000000',
                  status: { code: 'STATUS_CODE_ERROR' },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.rejected).toEqual([]);
    expect(result.spans[0]).toMatchObject({
      serviceName: 'snake',
      kind: 3,
      statusCode: 2,
      parentSpanId: null, // all-zero parent means "no parent"
      durationMs: 2000,
    });
  });

  it('falls back to unknown_service when service.name is missing', () => {
    const result = parseExportTraceServiceRequest({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                otlpPayload({
                  s: [{ traceId, spanId: randomSpanId(), name: 'n', startMs: 0, durationMs: 1 }],
                }).resourceSpans[0]!.scopeSpans[0]!.spans[0],
              ],
            },
          ],
        },
      ],
    });
    expect(result.spans[0]!.serviceName).toBe('unknown_service');
  });

  it('throws PayloadError for structurally invalid requests', () => {
    expect(() => parseExportTraceServiceRequest(null)).toThrow(PayloadError);
    expect(() => parseExportTraceServiceRequest([])).toThrow(PayloadError);
    expect(() => parseExportTraceServiceRequest({ resourceSpans: 'nope' })).toThrow(PayloadError);
  });

  it('accepts an empty request (exporters may send heartbeats)', () => {
    expect(parseExportTraceServiceRequest({})).toEqual({ spans: [], rejected: [] });
  });

  it('caps the number of spans per request', () => {
    const many = Array.from({ length: LIMITS.maxSpansPerRequest + 1 }, (_, i) => ({
      traceId,
      spanId: (i + 1).toString(16).padStart(16, '0'),
      name: 's',
      startMs: 0,
      durationMs: 1,
    }));
    expect(() => parseExportTraceServiceRequest(otlpPayload({ svc: many }))).toThrow(
      /more than 10000 spans/,
    );
  });

  it('drops prototype-polluting attribute keys', () => {
    const payload = otlpPayload({
      svc: [{ traceId, spanId: randomSpanId(), name: 'p', startMs: 0, durationMs: 1 }],
    });
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0] as { attributes: unknown[] };
    span.attributes = [
      { key: '__proto__', value: { stringValue: 'polluted' } },
      { key: 'safe', value: { stringValue: 'yes' } },
    ];
    const [parsed] = parseExportTraceServiceRequest(payload).spans;
    expect(parsed!.attributes).toEqual({ safe: 'yes' });
    expect(parsed!.droppedCount).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('limits attributes per span', () => {
    const payload = otlpPayload({
      svc: [{ traceId, spanId: randomSpanId(), name: 'p', startMs: 0, durationMs: 1 }],
    });
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0] as { attributes: unknown[] };
    span.attributes = Array.from({ length: 200 }, (_, i) => ({
      key: `k${i}`,
      value: { intValue: i },
    }));
    const [parsed] = parseExportTraceServiceRequest(payload).spans;
    expect(Object.keys(parsed!.attributes)).toHaveLength(LIMITS.maxAttributesPerSpan);
    expect(parsed!.droppedCount).toBe(200 - LIMITS.maxAttributesPerSpan);
  });
});

describe('error classification', () => {
  const base = {
    events: [] as Array<{ name: string; timeUnixNano: string; attributes: Record<string, never> }>,
  };
  it('uses span status as the source of truth', () => {
    expect(isErrorSpan({ ...base, statusCode: 2 })).toBe(true);
    expect(isErrorSpan({ ...base, statusCode: 1 })).toBe(false);
    expect(isErrorSpan({ ...base, statusCode: 0 })).toBe(false);
  });

  it('treats an escaped exception on an UNSET span as an error, but OK always wins', () => {
    const events = [
      { name: 'exception', timeUnixNano: '1', attributes: { 'exception.escaped': true } },
    ];
    expect(isErrorSpan({ statusCode: 0, events: events as never })).toBe(true);
    expect(isErrorSpan({ statusCode: 1, events: events as never })).toBe(false);
    const handled = [{ name: 'exception', timeUnixNano: '1', attributes: {} }];
    expect(isErrorSpan({ statusCode: 0, events: handled as never })).toBe(false);
  });
});
