/**
 * Vitest global setup for integration tests: points every test at an
 * isolated database (traceflow_test by default) and applies migrations.
 */
import { runMigrations } from '../packages/db/src/migrate';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://traceflow:traceflow@127.0.0.1:5544/traceflow_test';

export default async function setup(): Promise<void> {
  process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
  try {
    await runMigrations(TEST_DATABASE_URL);
  } catch (error) {
    throw new Error(
      `Integration tests need PostgreSQL at ${TEST_DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}. ` +
        `Start it with \`pnpm db:up\`. Cause: ${(error as Error).message}`,
      { cause: error },
    );
  }
}
