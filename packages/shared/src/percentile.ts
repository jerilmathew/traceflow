/**
 * Percentile with linear interpolation between closest ranks.
 *
 * This is deliberately the same definition PostgreSQL uses for
 * `percentile_cont(p) WITHIN GROUP (ORDER BY x)`, so numbers computed in the
 * browser (e.g. for a single trace) agree with numbers computed in SQL.
 *
 *   rank = p * (n - 1)
 *   value = v[floor(rank)] + (v[ceil(rank)] - v[floor(rank)]) * frac(rank)
 *
 * Returns null for an empty input. `p` must be within [0, 1].
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`percentile must be within [0, 1], got ${p}`);
  }
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  return percentileOfSorted(sorted, p);
}

/** Same as {@link percentile} but expects an ascending, finite array (no copy, O(1)). */
export function percentileOfSorted(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const lower = sorted[lo]!;
  const upper = sorted[hi]!;
  return lower + (upper - lower) * (rank - lo);
}

export function latencyPercentiles(values: readonly number[]): {
  p50: number | null;
  p95: number | null;
  p99: number | null;
} {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    p50: percentileOfSorted(sorted, 0.5),
    p95: percentileOfSorted(sorted, 0.95),
    p99: percentileOfSorted(sorted, 0.99),
  };
}
