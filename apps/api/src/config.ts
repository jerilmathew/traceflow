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
  /** Requests per minute per client IP (0 disables). Set this when exposing the API publicly. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(0),
  /**
   * Comma-separated IPs/CIDRs of the reverse proxies in front of the API (or
   * proxy-addr names such as `uniquelocal`). X-Forwarded-For is honoured only
   * when the immediate peer is in this list, so callers cannot spoof their
   * address to dodge the rate limit. Empty trusts nothing.
   */
  TRUST_PROXY: z.string().default(''),
  /** Abort API queries that run longer than this. */
  API_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type ApiConfig = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig => schema.parse(env);
