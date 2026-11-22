/**
 * OpenTelemetry bootstrap for the TraceFlow example services.
 *
 * - NodeSDK with W3C Trace Context + Baggage propagation (the SDK default).
 * - OTLP/HTTP **JSON** exporter pointed at the TraceFlow collector.
 * - Automatic instrumentation for inbound/outbound `node:http` and `pg`.
 * - `tracedFetch`: an explicit client-span wrapper around global `fetch`
 *   that shows exactly how context propagation works (see below).
 */
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_URL_FULL,
  ATTR_ERROR_TYPE,
} from '@opentelemetry/semantic-conventions';

export const DEFAULT_TRACES_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /** Full OTLP/HTTP traces URL. Defaults to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or the local collector. */
  endpoint?: string;
  /** Instrument the `pg` driver (Inventory service). */
  postgres?: boolean;
}

let sdk: NodeSDK | undefined;

export function startTelemetry(options: TelemetryOptions): NodeSDK {
  if (sdk) return sdk;
  const endpoint =
    options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? DEFAULT_TRACES_ENDPOINT;

  const exporter = new OTLPTraceExporter({ url: endpoint, timeoutMillis: 5_000 });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.1.0',
      'deployment.environment.name': options.environment ?? process.env.DEPLOY_ENV ?? 'demo',
    }),
    // Small batches and a short delay keep the demo feeling "live".
    spanProcessors: [
      new BatchSpanProcessor({
        exporter,
        scheduledDelayMillis: 300,
        maxExportBatchSize: 256,
        maxQueueSize: 4096,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        // Health probes are noise; don't trace them.
        ignoreIncomingRequestHook: (req) => req.url === '/health',
      }),
      ...(options.postgres ? [new PgInstrumentation({ ignoreConnectSpans: true, requireParentSpan: true })] : []),
    ],
  });
  sdk.start();

  const shutdown = () => {
    sdk
      ?.shutdown()
      .catch((error: unknown) => console.error('telemetry shutdown failed', error))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return sdk;
}

/** Flush and stop the SDK (used by scripts that exit on their own). */
export async function stopTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

export interface TracedFetchInit extends RequestInit {
  /**
   * Span name. Should be low-cardinality (a route template, not a concrete
   * URL with ids in it); defaults to "<METHOD> <path>".
   */
  spanName?: string;
  /** Logical name of the callee, recorded as `peer.service`. */
  peerService?: string;
}

/**
 * `fetch` with an explicit CLIENT span and W3C Trace Context propagation.
 *
 * This is the heart of distributed tracing:
 *   1. start a CLIENT span as a child of whatever span is currently active;
 *   2. `propagation.inject` writes `traceparent: 00-<traceId>-<thisSpanId>-01`
 *      (and `tracestate` / `baggage`) into the outgoing headers;
 *   3. the callee's HTTP instrumentation extracts that header and starts its
 *      SERVER span with *this* span as parent — same trace id, linked spans.
 */
export async function tracedFetch(url: string | URL, init: TracedFetchInit = {}): Promise<Response> {
  const tracer = trace.getTracer('@traceflow/telemetry');
  const target = new URL(url);
  const method = (init.method ?? 'GET').toUpperCase();
  const name = init.spanName ?? `${method} ${target.pathname}`;

  const attributes: Attributes = {
    [ATTR_HTTP_REQUEST_METHOD]: method,
    [ATTR_URL_FULL]: target.toString(),
    [ATTR_SERVER_ADDRESS]: target.hostname,
    [ATTR_SERVER_PORT]: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
  };
  if (init.peerService) attributes['peer.service'] = init.peerService;

  return tracer.startActiveSpan(name, { kind: SpanKind.CLIENT, attributes }, async (span: Span) => {
    const headers = new Headers(init.headers);
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    for (const [key, value] of Object.entries(carrier)) headers.set(key, value);

    try {
      const { spanName: _spanName, peerService: _peer, ...rest } = init;
      const response = await fetch(target, { ...rest, method, headers });
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
      // OTel HTTP semconv: for CLIENT spans any 4xx/5xx is an error.
      if (response.status >= 400) {
        span.setAttribute(ATTR_ERROR_TYPE, String(response.status));
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
      }
      return response;
    } catch (error) {
      span.recordException(error as Error);
      span.setAttribute(ATTR_ERROR_TYPE, (error as Error).name ?? 'Error');
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Run `fn` inside an INTERNAL span. Exceptions are recorded on the span,
 * marked as ERROR, and re-thrown.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer('@traceflow/telemetry');
  return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Id of the trace the current request belongs to (for response headers / logs). */
export function currentTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}

/** Rename the active server span to "<METHOD> <route>" and set `http.route`. */
export function nameServerSpan(method: string, route: string): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.updateName(`${method} ${route}`);
  span.setAttribute('http.route', route);
}

/** Mark the active span as failed with an exception (used by HTTP error handlers). */
export function failActiveSpan(error: Error): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}
