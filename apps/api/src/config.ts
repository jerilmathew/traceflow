import { z } from 'zod';
import { DEFAULT_DATABASE_URL } from '@traceflow/db';

const schema = z.object({
  DATABASE_URL: z.string().default(DEFAULT_DATABASE_URL),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4400),
  CORS_ORIGINS: z.string().default('http://localhost:5180,http://127.0.0.1:5180'),
  /** Serve the built dashboard (apps/web/dist) from the API when present. */
  SERVE_WEB: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type ApiConfig = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig => schema.parse(env);
