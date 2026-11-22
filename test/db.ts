import { createDb, type DbHandle } from '../packages/db/src/client';

export function testDb(): DbHandle {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://traceflow:traceflow@127.0.0.1:5544/traceflow_test';
  return createDb({ url, max: 20, applicationName: 'traceflow-tests' });
}

export async function resetDb(handle: DbHandle): Promise<void> {
  await handle.sql`truncate spans, traces, services restart identity cascade`;
}
