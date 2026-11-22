import { describe, expect, it } from 'vitest';
import { formatDuration, formatPercent, formatRate } from '../src/format';
import { isValidSpanId, isValidTraceId } from '../src/ids';

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [0.42, '420µs'],
    [1.5, '1.5ms'],
    [12.34, '12.3ms'],
    [480, '480ms'],
    [1532, '1.53s'],
    [61_000, '1m 1s'],
  ])('%s → %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });

  it('renders an em dash for missing values', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatPercent / formatRate', () => {
  it('formats ratios', () => {
    expect(formatPercent(0.1234)).toBe('12.3%');
    expect(formatPercent(null)).toBe('—');
  });
  it('picks a readable rate unit', () => {
    expect(formatRate(2.5)).toBe('2.5/s');
    expect(formatRate(0.5)).toBe('30/min');
    expect(formatRate(0)).toBe('0/s');
  });
});

describe('OpenTelemetry identifiers', () => {
  it('accepts canonical lowercase hex ids', () => {
    expect(isValidTraceId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(true);
    expect(isValidSpanId('00f067aa0ba902b7')).toBe(true);
  });
  it('rejects all-zero, wrong-length and uppercase ids', () => {
    expect(isValidTraceId('0'.repeat(32))).toBe(false);
    expect(isValidSpanId('0'.repeat(16))).toBe(false);
    expect(isValidTraceId('4bf92f3577b34da6')).toBe(false);
    expect(isValidSpanId('00F067AA0BA902B7')).toBe(false);
  });
});
