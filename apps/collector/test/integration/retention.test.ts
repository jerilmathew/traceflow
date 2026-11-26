import { afterAll, beforeEach, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../test/db';
import { ingestSpans } from '../../src/ingest';
import { parseExportTraceServiceRequest } from '../../src/otlp/parse';
import { deleteExpiredTraces } from '../../src/retention';
import { otlpPayload, randomSpanId, randomTraceId } from '../helpers';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.close());

const HOUR = 3_600_000;
async function seed(startMs: number, traceId = randomTraceId()) {
  const { spans } = parseExportTraceServiceRequest(
    otlpPayload({ svc: [{ traceId, spanId: randomSpanId(), name: 'op', startMs, durationMs: 5 }] }),
  );
  await ingestSpans(db.sql, spans);
  return traceId;
}

it('deletes only traces that ended before the cutoff, with their spans', async () => {
  await seed(-5 * HOUR);
  const recent = await seed(0);
  expect(await deleteExpiredTraces(db.sql, new Date(Date.now() - HOUR))).toBe(1);
  expect((await db.sql`select trace_id from traces`).map((r) => r.trace_id)).toEqual([recent]);
  expect((await db.sql`select trace_id from spans`).map((r) => r.trace_id)).toEqual([recent]);
  expect(await deleteExpiredTraces(db.sql, new Date(Date.now() - HOUR))).toBe(0);
});

it('keeps an old trace that has since received a newer span', async () => {
  const traceId = await seed(-5 * HOUR);
  await seed(0, traceId);
  expect(await deleteExpiredTraces(db.sql, new Date(Date.now() - HOUR))).toBe(0);
  expect(await db.sql`select 1 from spans where trace_id = ${traceId}`).toHaveLength(2);
});

it('works through more rows than one batch', async () => {
  const spans = Array.from({ length: 1100 }, () => ({
    traceId: randomTraceId(),
    spanId: randomSpanId(),
    name: 'op',
    startMs: -5 * HOUR,
    durationMs: 1,
  }));
  await ingestSpans(db.sql, parseExportTraceServiceRequest(otlpPayload({ svc: spans })).spans);
  expect(await deleteExpiredTraces(db.sql, new Date(Date.now() - HOUR))).toBe(1100);
  expect(await db.sql`select 1 from spans`).toHaveLength(0);
});
