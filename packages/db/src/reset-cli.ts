/**
 * Delete all stored telemetry (spans, traces, services) from the configured
 * TraceFlow database. Schema and migrations are kept. Used for clean demos.
 */
import { DEFAULT_DATABASE_URL, createDb, redactUrl } from './client';

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const { sql, close } = createDb({ url, max: 1 });
try {
  await sql`truncate spans, traces, services restart identity cascade`;
  console.log(`✓ cleared all telemetry in ${redactUrl(url)}`);
} finally {
  await close();
}
