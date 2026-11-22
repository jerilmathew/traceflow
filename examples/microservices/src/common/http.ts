import Fastify, { type FastifyInstance } from 'fastify';
import { currentTraceId, failActiveSpan, nameServerSpan } from '@traceflow/telemetry';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'error',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Fastify instance with tracing conveniences:
 * - names the HTTP server span "<METHOD> <route>" (low-cardinality),
 * - returns the trace id in `x-trace-id` so callers can look the trace up,
 * - marks the server span as failed for 5xx responses with the exception.
 */
export function createServer(serviceName: string): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn', name: serviceName } });

  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url ?? request.url;
    nameServerSpan(request.method, route);
    const traceId = currentTraceId();
    if (traceId) void reply.header('x-trace-id', traceId);
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    const status = error instanceof HttpError ? error.statusCode : (error.statusCode ?? 500);
    if (status >= 500) {
      failActiveSpan(error);
      request.log.error({ err: error }, 'request failed');
    }
    void reply.status(status).send({
      error: { code: error instanceof HttpError ? error.code : (error.code ?? 'internal_error'), message: error.message },
      traceId: currentTraceId(),
    });
  });

  app.get('/health', async () => ({ status: 'ok', service: serviceName }));
  return app;
}
