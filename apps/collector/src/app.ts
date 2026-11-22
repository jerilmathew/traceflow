import { Transform, type Readable } from 'node:stream';
import { createGunzip, createInflate } from 'node:zlib';
import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { pingDb, type Sql } from '@traceflow/db';
import { ingestSpans } from './ingest';
import { PayloadError, parseExportTraceServiceRequest } from './otlp/parse';

export interface CollectorOptions {
  sql: Sql;
  bodyLimit?: number;
  corsOrigins?: string[];
  logLevel?: string;
}

/** gRPC status codes used in OTLP/HTTP error bodies (google.rpc.Status). */
const GRPC = {
  INVALID_ARGUMENT: 3,
  UNAVAILABLE: 14,
  UNIMPLEMENTED: 12,
  RESOURCE_EXHAUSTED: 8,
} as const;

/** Errors from postgres.js that mean "database unreachable / overloaded" → retryable. */
function isTransientDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code ?? '';
  return (
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'CONNECT_TIMEOUT',
      'CONNECTION_CLOSED',
      'CONNECTION_ENDED',
      'CONNECTION_DESTROYED',
      'EPIPE',
    ].includes(code) ||
    // 57P01 admin_shutdown, 57P03 cannot_connect_now, 53300 too_many_connections, 40P01 deadlock
    ['57P01', '57P03', '53300', '40P01'].includes(code)
  );
}

/** Caps the number of decompressed bytes so a tiny gzip bomb cannot exhaust memory. */
function byteLimit(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) {
        const err = new Error(
          `request body exceeds ${limit} bytes after decompression`,
        ) as Error & {
          statusCode: number;
          code: string;
        };
        err.statusCode = 413;
        err.code = 'FST_ERR_CTP_BODY_TOO_LARGE';
        cb(err);
        return;
      }
      cb(null, chunk);
    },
  });
}

export async function buildCollector(options: CollectorOptions): Promise<FastifyInstance> {
  const bodyLimit = options.bodyLimit ?? 8 * 1024 * 1024;
  const app = Fastify({
    bodyLimit,
    logger: {
      level: options.logLevel ?? 'info',
      // Never log request bodies (telemetry may contain user data) or auth headers.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Per-request access logs would fire for every export batch; we log a
    // single structured line per ingest instead.
    logController: new LogController({ disableRequestLogging: true }),
  });

  await app.register(cors, {
    origin: options.corsOrigins ?? false,
    methods: ['POST', 'GET'],
  });

  // Transparent gzip/deflate support (OTLP exporters may compress payloads).
  app.addHook('preParsing', async (request, _reply, payload) => {
    const encoding = (request.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (encoding === 'identity') return payload;
    let decoder: Transform;
    if (encoding === 'gzip') decoder = createGunzip();
    else if (encoding === 'deflate') decoder = createInflate();
    else {
      const err = new Error(`unsupported content-encoding "${encoding}"`) as Error & {
        statusCode: number;
      };
      err.statusCode = 415;
      throw err;
    }
    const source = payload as Readable & { receivedEncodedLength?: number };
    const decoded = source.pipe(decoder).pipe(byteLimit(bodyLimit)) as Transform & {
      receivedEncodedLength: number;
    };
    // Fastify compares Content-Length with the *encoded* byte count.
    decoded.receivedEncodedLength = 0;
    source.on('data', (chunk: Buffer) => {
      decoded.receivedEncodedLength += chunk.length;
    });
    decoder.on('error', (e) => decoded.destroy(Object.assign(e, { statusCode: 400 })));
    return decoded;
  });

  // Protobuf is part of OTLP/HTTP but not implemented by this MVP: say so explicitly.
  app.addContentTypeParser(
    ['application/x-protobuf', 'application/protobuf'],
    (_req, _payload, done) => {
      const err = new Error(
        'OTLP/HTTP protobuf is not supported by TraceFlow yet; configure your exporter to send JSON (OTEL_EXPORTER_OTLP_PROTOCOL=http/json)',
      ) as Error & { statusCode: number };
      err.statusCode = 415;
      done(err);
    },
  );

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'collector error');
    const grpc =
      status === 415
        ? GRPC.UNIMPLEMENTED
        : status === 413
          ? GRPC.RESOURCE_EXHAUSTED
          : status < 500
            ? GRPC.INVALID_ARGUMENT
            : GRPC.UNAVAILABLE;
    void reply
      .status(status)
      .send({ code: grpc, message: status >= 500 ? 'internal error' : error.message });
  });

  app.get('/', async () => ({
    name: 'traceflow-collector',
    protocols: ['otlp/http+json'],
    endpoints: { traces: 'POST /v1/traces', health: 'GET /health' },
  }));

  app.get('/health', async (_req, reply) => {
    const db = await pingDb(options.sql);
    return reply
      .status(db ? 200 : 503)
      .send({ status: db ? 'ok' : 'degraded', database: db ? 'up' : 'down' });
  });

  app.post('/v1/traces', async (request, reply) => {
    const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (contentType !== 'application/json') {
      return reply.status(415).send({
        code: GRPC.UNIMPLEMENTED,
        message: `unsupported content-type "${contentType || '(none)'}"; send OTLP/HTTP JSON (application/json)`,
      });
    }

    let parsed;
    try {
      parsed = parseExportTraceServiceRequest(request.body);
    } catch (error) {
      if (error instanceof PayloadError) {
        return reply.status(400).send({ code: GRPC.INVALID_ARGUMENT, message: error.message });
      }
      throw error;
    }

    try {
      const result = await ingestSpans(options.sql, parsed.spans);
      request.log.info(
        {
          received: result.receivedSpans + parsed.rejected.length,
          accepted: result.acceptedSpans,
          duplicates: result.duplicateSpans,
          rejected: parsed.rejected.length,
          traces: result.traceIds.length,
        },
        'ingested spans',
      );
    } catch (error) {
      if (isTransientDbError(error)) {
        request.log.warn(
          { code: (error as { code?: string }).code },
          'database unavailable; asking exporter to retry',
        );
        // 503 + Retry-After is a *retryable* response per the OTLP spec, so the
        // SDK keeps the batch and re-sends it with backoff instead of dropping it.
        return reply.status(503).header('retry-after', '5').send({
          code: GRPC.UNAVAILABLE,
          message: 'storage temporarily unavailable, retry later',
        });
      }
      throw error;
    }

    // ExportTraceServiceResponse. partialSuccess is only set when something was rejected.
    if (parsed.rejected.length > 0) {
      const sample = parsed.rejected
        .slice(0, 5)
        .map((r) => `span[${r.index}]: ${r.reason}`)
        .join('; ');
      return reply.status(200).send({
        partialSuccess: {
          rejectedSpans: String(parsed.rejected.length),
          errorMessage: `${parsed.rejected.length} span(s) rejected: ${sample}`,
        },
      });
    }
    return reply.status(200).send({});
  });

  return app;
}
