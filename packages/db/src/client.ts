import postgres from 'postgres';

export const DEFAULT_DATABASE_URL = 'postgres://traceflow:traceflow@127.0.0.1:5544/traceflow';

export type Sql = postgres.Sql;

/**
 * Drizzle owns the schema definition and migrations (src/schema.ts, ./drizzle).
 * Runtime queries are hand-written, parameterised SQL through postgres.js
 * tagged templates: the analytical queries (percentile_cont, date_bin,
 * self-joins, advisory locks) read more clearly as SQL than through a query
 * builder. Note that `drizzle(client)` replaces the client's type serializers,
 * so the runtime client is deliberately *not* shared with a Drizzle instance.
 */
export interface DbHandle {
  sql: Sql;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  url?: string;
  /** Max pool size. */
  max?: number;
  /** Application name visible in pg_stat_activity. */
  applicationName?: string;
}

export function createDb(options: CreateDbOptions = {}): DbHandle {
  const url = options.url ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const sql = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 5,
    // bigint columns come back as JS BigInt instead of lossy numbers / strings.
    types: { bigint: postgres.BigInt },
    connection: { application_name: options.applicationName ?? 'traceflow' },
    onnotice: () => {},
  });
  return { sql, close: () => sql.end({ timeout: 5 }) };
}

/** Lightweight connectivity probe used by health endpoints. */
export async function pingDb(sql: Sql, timeoutMs = 1500): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sql`select 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('db ping timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Redact the password from a connection string before logging it. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid database url>';
  }
}
