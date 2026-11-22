import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { parse as parseYaml } from 'yaml';
import type { Sql } from '@traceflow/db';
import { ApiError } from './errors';
import { LiveHub } from './live';
import { registerRoutes } from './routes';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OPENAPI_PATH = path.resolve(here, '../../../docs/openapi.yaml');
const WEB_DIST = path.resolve(here, '../../web/dist');

export interface ApiOptions {
  sql: Sql;
  corsOrigins?: string[];
  logLevel?: string;
  serveWeb?: boolean;
  /** Start LISTEN for live updates (disable in tests that don't need it). */
  live?: boolean;
}

export async function buildApi(options: ApiOptions): Promise<FastifyInstance & { live: LiveHub }> {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    // Trace ids, service names etc. arrive in the URL; keep it bounded.
    routerOptions: { maxParamLength: 300 },
  });

  await app.register(cors, {
    origin: options.corsOrigins ?? false,
    methods: ['GET'],
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
    if (error instanceof ApiError) return reply.status(error.statusCode).send(error.toBody());
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      const code = (error as { code?: string }).code;
      const dbDown = typeof code === 'string' && /^(ECONNREFUSED|CONNECT_TIMEOUT|CONNECTION_|57P0)/.test(code);
      request.log.error({ err: error }, 'request failed');
      return reply
        .status(dbDown ? 503 : 500)
        .send(
          dbDown
            ? { error: { code: 'storage_unavailable', message: 'database is temporarily unavailable' } }
            : { error: { code: 'internal_error', message: 'internal server error' } },
        );
    }
    return reply.status(status).send({ error: { code: 'bad_request', message: error.message } });
  });

  const live = new LiveHub(options.sql, app.log);
  if (options.live !== false) {
    // Don't block startup if the database is down; postgres.js keeps retrying.
    live.start().catch((error: unknown) => app.log.warn({ err: error }, 'LISTEN failed; live updates disabled until restart'));
    app.addHook('onClose', async () => live.stop());
  }

  registerRoutes(app, { sql: options.sql, live });

  app.get('/api/openapi.json', async () => parseYaml(readFileSync(OPENAPI_PATH, 'utf8')) as unknown);

  if (options.serveWeb !== false && existsSync(path.join(WEB_DIST, 'index.html'))) {
    await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
    // Single-page app: unknown non-API GETs fall back to index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'not_found', message: `route ${request.method} ${request.url.split('?')[0]} not found` } });
    });
  } else {
    app.setNotFoundHandler((request, reply) =>
      reply.status(404).send({ error: { code: 'not_found', message: `route ${request.method} ${request.url.split('?')[0]} not found` } }),
    );
  }

  return Object.assign(app, { live }) as unknown as FastifyInstance & { live: LiveHub };
}
