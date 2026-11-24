import { createDb, type DbHandle } from '../packages/db/src/client';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://traceflow:traceflow@127.0.0.1:5544/traceflow_test';

export function testDb(): DbHandle {
  return createDb({ url: TEST_DATABASE_URL, max: 20, applicationName: 'traceflow-tests' });
}

export async function resetDb(handle: DbHandle): Promise<void> {
  await handle.sql`truncate spans, traces, services restart identity cascade`;
}
