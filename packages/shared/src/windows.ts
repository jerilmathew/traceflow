import type { TimeWindow } from './types';

export const TIME_WINDOWS: readonly TimeWindow[] = ['15m', '1h', '6h', '24h', '7d'] as const;

export const WINDOW_SECONDS: Record<TimeWindow, number> = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
};

/** Bucket width used for time series so every window renders ~30-60 points. */
export const WINDOW_BUCKET_SECONDS: Record<TimeWindow, number> = {
  '15m': 30,
  '1h': 60,
  '6h': 10 * 60,
  '24h': 30 * 60,
  '7d': 4 * 60 * 60,
};

export const WINDOW_LABELS: Record<TimeWindow, string> = {
  '15m': 'Last 15 minutes',
  '1h': 'Last hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
};

export function isTimeWindow(value: unknown): value is TimeWindow {
  return typeof value === 'string' && (TIME_WINDOWS as readonly string[]).includes(value);
}
