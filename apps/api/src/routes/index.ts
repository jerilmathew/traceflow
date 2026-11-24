import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pingDb, type Sql } from '@traceflow/db';
import { TIME_WINDOWS, isValidTraceId, type DemoInfo, type TimeWindow } from '@traceflow/shared';
import { ApiError, notFound } from '../errors';
import type { LiveHub } from '../live';
import {
  getDependencyGraph,
  getOverview,
  getServiceDetail,
  listServices,
  windowRange,
} from '../queries/metrics';
import { getTraceDetail, searchTraces } from '../queries/traces';
import { registerStream } from './stream';

const windowSchema = z.enum(TIME_WINDOWS as [TimeWindow, ...TimeWindow[]]).default('1h');

const optionalNumber = z
  .union([z.literal(''), z.coerce.number().finite().min(0)])
  .optional()
  .transform((v) => (v === '' || v === undefined ? undefined : v));

const optionalDate = z
  .union([z.literal(''), z.iso.datetime({ offset: true })])
  .optional()
  .transform((v) => (v ? new Date(v) : undefined));

const traceSearchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  service: z
    .string()
    .trim()
    .max(256)
    .optional()
    .transform((v) => v || undefined),
  status: z
    .enum(['ok', 'error', 'all'])
    .optional()
    .transform((v) => (v === 'all' ? undefined : v)),
  minDurationMs: optionalNumber,
  maxDurationMs: optionalNumber,
  from: optionalDate,
  to: optionalDate,
  sort: z.enum(['startTime', 'duration', 'spanCount']).default('startTime'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Parse with zod and turn failures into a consistent 400 response. */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      400,
      'invalid_request',
      'invalid query parameters',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export interface RouteDeps {
  sql: Sql;
  live: LiveHub;
  clientId: (request: FastifyRequest) => string;
  demo: DemoInfo | null;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { sql, live, clientId, demo } = deps;

  app.get('/api/meta', async () => ({ demo }));

  app.get('/api/health', async (_req, reply) => {
    const database = await pingDb(sql);
    return reply.status(database ? 200 : 503).send({
      status: database ? 'ok' : 'degraded',
      database: database ? 'up' : 'down',
      live: live.listening ? 'listening' : 'disconnected',
    });
  });

  app.get('/api/overview', async (req) => {
    const { window } = parse(z.object({ window: windowSchema }), req.query);
    return getOverview(sql, windowRange(window));
  });

  app.get('/api/traces', async (req) => {
    const search = parse(traceSearchSchema, req.query);
    if (
      search.minDurationMs !== undefined &&
      search.maxDurationMs !== undefined &&
      search.minDurationMs > search.maxDurationMs
    ) {
      throw new ApiError(400, 'invalid_request', 'minDurationMs must be <= maxDurationMs');
    }
    return searchTraces(sql, search);
  });

  app.get<{ Params: { traceId: string } }>('/api/traces/:traceId', async (req) => {
    const traceId = req.params.traceId.toLowerCase();
    if (!isValidTraceId(traceId)) {
      throw new ApiError(400, 'invalid_trace_id', 'trace id must be 32 lowercase hex characters');
    }
    const detail = await getTraceDetail(sql, traceId);
    if (!detail) throw notFound(`trace ${traceId}`);
    return detail;
  });

  app.get('/api/services', async (req) => {
    const { window } = parse(z.object({ window: windowSchema }), req.query);
    const range = windowRange(window);
    return { window, items: await listServices(sql, range) };
  });

  app.get<{ Params: { name: string } }>('/api/services/:name', async (req) => {
    const { window } = parse(z.object({ window: windowSchema }), req.query);
    const name = parse(z.string().min(1).max(256), req.params.name);
    const detail = await getServiceDetail(sql, windowRange(window), name);
    if (!detail) throw notFound(`service "${name}" with telemetry in the selected window`);
    return detail;
  });

  app.get('/api/dependencies', async (req) => {
    const { window } = parse(z.object({ window: windowSchema }), req.query);
    return getDependencyGraph(sql, windowRange(window));
  });

  registerStream(app, live, clientId);
}
