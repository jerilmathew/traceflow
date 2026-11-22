import { createDb } from '../packages/db/src/client';
import { runMigrations } from '../packages/db/src/migrate';

/** Start every E2E run from an empty, migrated database. */
export default async function globalSetup(): Promise<void> {
  const url =
    process.env.E2E_DATABASE_URL ?? 'postgres://traceflow:traceflow@127.0.0.1:5544/traceflow_e2e';
  await runMigrations(url);
  const { sql, close } = createDb({ url, max: 1 });
  await sql`truncate spans, traces, services restart identity cascade`;
  await close();
}
