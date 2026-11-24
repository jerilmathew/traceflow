import { z } from 'zod';
import { DEFAULT_DATABASE_URL } from '@traceflow/db';

const schema = z.object({
  DATABASE_URL: z.string().default(DEFAULT_DATABASE_URL),
  COLLECTOR_HOST: z.string().default('127.0.0.1'),
  COLLECTOR_PORT: z.coerce.number().int().min(1).max(65535).default(4318),
  /** Max request body, after gzip decompression. */
  COLLECTOR_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
  CORS_ORIGINS: z.string().default('http://localhost:5180,http://127.0.0.1:5180'),
  /** Delete traces that ended more than this many hours ago (0 keeps everything). */
  RETENTION_HOURS: z.coerce.number().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type CollectorConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  return schema.parse(env);
}
