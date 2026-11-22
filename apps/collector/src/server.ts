import { createDb, redactUrl } from '@traceflow/db';
import { buildCollector } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { sql, close } = createDb({ url: config.DATABASE_URL, applicationName: 'traceflow-collector' });
const app = await buildCollector({
  sql,
  bodyLimit: config.COLLECTOR_BODY_LIMIT_BYTES,
  corsOrigins: config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  logLevel: config.LOG_LEVEL,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down collector');
  await app.close();
  await close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.COLLECTOR_HOST, port: config.COLLECTOR_PORT });
app.log.info(`OTLP/HTTP JSON receiver ready → POST http://${config.COLLECTOR_HOST}:${config.COLLECTOR_PORT}/v1/traces (db ${redactUrl(config.DATABASE_URL)})`);
