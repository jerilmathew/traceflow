import { createDb, redactUrl } from '@traceflow/db';
import { buildApi } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { sql, close } = createDb({
  url: config.DATABASE_URL,
  applicationName: 'traceflow-api',
  statementTimeoutMs: config.API_STATEMENT_TIMEOUT_MS,
  readOnly: true,
});
const app = await buildApi({
  sql,
  corsOrigins: config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  logLevel: config.LOG_LEVEL,
  serveWeb: config.SERVE_WEB,
  rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
  trustProxy: config.TRUST_PROXY,
  globalRateLimitPerMinute: config.GLOBAL_RATE_LIMIT_PER_MINUTE,
  clientIpHeader: config.CLIENT_IP_HEADER,
  demo: config.PUBLIC_DEMO
    ? { retentionHours: config.RETENTION_HOURS, sourceUrl: config.SOURCE_URL || null }
    : null,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down api');
  await app.close();
  await close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
app.log.info(
  `TraceFlow API ready on http://${config.API_HOST}:${config.API_PORT} (db ${redactUrl(config.DATABASE_URL)})`,
);
