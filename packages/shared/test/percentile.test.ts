import { describe, expect, it } from 'vitest';
import { latencyPercentiles, percentile } from '../src/percentile';

describe('percentile', () => {
  it('returns null for empty input', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(latencyPercentiles([])).toEqual({ p50: null, p95: null, p99: null });
  });

  it('returns the only element for a single value', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });

  it('interpolates linearly like PostgreSQL percentile_cont', () => {
    // percentile_cont(0.5) of {1,2,3,4} = 2.5
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    // rank = 0.95 * 9 = 8.55 -> 9 + (10 - 9) * 0.55
    const tenValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(tenValues, 0.95)).toBeCloseTo(9.55, 10);
    expect(percentile(tenValues, 0)).toBe(1);
    expect(percentile(tenValues, 1)).toBe(10);
  });

  it('is robust to unsorted input and ignores non-finite values', () => {
    expect(percentile([10, Number.NaN, 0, Number.POSITIVE_INFINITY, 5], 0.5)).toBe(5);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    percentile(input, 0.5);
    expect(input).toEqual([3, 1, 2]);
  });

  it('rejects out-of-range quantiles', () => {
    expect(() => percentile([1], 1.5)).toThrow(RangeError);
    expect(() => percentile([1], -0.1)).toThrow(RangeError);
  });

  it('computes the p50/p95/p99 triple on a skewed latency distribution', () => {
    // 98 fast requests and 2 slow outliers: the tail percentiles must expose them.
    const values = [...Array.from({ length: 98 }, () => 20), 900, 1000];
    const result = latencyPercentiles(values);
    expect(result.p50).toBe(20);
    expect(result.p95).toBe(20);
    // rank = 0.99 * 99 = 98.01 -> 900 + 100 * 0.01
    expect(result.p99).toBeCloseTo(901, 6);
  });
});
