import type { Sql } from '@traceflow/db';
import { TRACE_LOCK_SEED } from './ingest';

const BATCH = 500;

/**
 * Delete traces (and their spans) that ended before `cutoff`, in small
 * transactions. Takes the same per-trace locks as ingestion, in the same
 * order, then re-checks the cutoff: a trace that received a late span while we
 * waited for its lock is kept. Returns the number of traces deleted.
 */
export async function deleteExpiredTraces(sql: Sql, cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const candidates = await sql<{ trace_id: string }[]>`
      select trace_id from traces where end_time < ${cutoff} order by end_time limit ${BATCH}`;
    if (candidates.length === 0) return total;
    const ids = JSON.stringify(candidates.map((r) => r.trace_id));

    const deleted = await sql.begin(async (tx) => {
      await tx`
        select pg_advisory_xact_lock(k)
        from (
          select distinct hashtextextended(t, ${TRACE_LOCK_SEED}::bigint) as k
          from jsonb_array_elements_text(${ids}::text::jsonb) as t order by k
        ) as locks`;
      const gone = await tx<{ trace_id: string }[]>`
        delete from traces
        where end_time < ${cutoff}
          and trace_id in (select t::char(32) from jsonb_array_elements_text(${ids}::text::jsonb) as t)
        returning trace_id`;
      await tx`
        delete from spans where trace_id in (
          select t::char(32)
          from jsonb_array_elements_text(${JSON.stringify(gone.map((r) => r.trace_id))}::text::jsonb) as t
        )`;
      return gone.length;
    });
    total += deleted;
    if (candidates.length < BATCH || deleted === 0) return total;
  }
}
