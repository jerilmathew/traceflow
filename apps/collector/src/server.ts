import { createDb, redactUrl } from '@traceflow/db';
import { buildCollector } from './app';
import { loadConfig } from './config';
import { deleteExpiredTraces } from './retention';

const config = loadConfig();
const { sql, close } = createDb({
  url: config.DATABASE_URL,
  applicationName: 'traceflow-collector',
});
const app = await buildCollector({
  sql,
  bodyLimit: config.COLLECTOR_BODY_LIMIT_BYTES,
  corsOrigins: config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  logLevel: config.LOG_LEVEL,
});

let retentionTimer: NodeJS.Timeout | undefined;
if (config.RETENTION_HOURS > 0) {
  const sweep = () =>
    deleteExpiredTraces(sql, new Date(Date.now() - config.RETENTION_HOURS * 3_600_000))
      .then((deleted) => deleted > 0 && app.log.info({ deleted }, 'expired traces deleted'))
      .catch((err: unknown) => app.log.warn({ err }, 'retention sweep failed; will retry'));
  retentionTimer = setInterval(() => void sweep(), 10 * 60_000);
  void sweep();
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down collector');
  clearInterval(retentionTimer);
  await app.close();
  await close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.COLLECTOR_HOST, port: config.COLLECTOR_PORT });
app.log.info(
  `OTLP/HTTP JSON receiver ready → POST http://${config.COLLECTOR_HOST}:${config.COLLECTOR_PORT}/v1/traces (db ${redactUrl(config.DATABASE_URL)})`,
);
