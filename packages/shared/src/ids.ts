/**
 * OpenTelemetry identifiers.
 *
 * - trace id: 16 bytes → 32 lowercase hex chars, must not be all zeros.
 * - span id:   8 bytes → 16 lowercase hex chars, must not be all zeros.
 *
 * TraceFlow stores identifiers in their canonical lowercase hex form so that
 * they compare byte-for-byte with the `traceparent` header values emitted by
 * W3C Trace Context propagation.
 */
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

export function isValidTraceId(value: string): boolean {
  return TRACE_ID_RE.test(value) && !/^0+$/.test(value);
}

export function isValidSpanId(value: string): boolean {
  return SPAN_ID_RE.test(value) && !/^0+$/.test(value);
}
