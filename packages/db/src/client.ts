import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DEFAULT_DATABASE_URL = 'postgres://traceflow:traceflow@127.0.0.1:5544/traceflow';

export type Database = PostgresJsDatabase<typeof schema>;
export type Sql = postgres.Sql;

export interface DbHandle {
  sql: Sql;
  db: Database;
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
  const db = drizzle(sql, { schema });
  return { sql, db, close: () => sql.end({ timeout: 5 }) };
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
