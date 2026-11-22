/** Human-friendly duration: 0.42ms → "420µs", 12.3 → "12.3ms", 1532 → "1.53s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 0) return `-${formatDuration(-ms)}`;
  if (ms === 0) return '0ms';
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 10) return `${trim(ms.toFixed(2))}ms`;
  if (ms < 1000) return `${trim(ms.toFixed(1))}ms`;
  if (ms < 60_000) return `${trim((ms / 1000).toFixed(2))}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function trim(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatRate(perSecond: number): string {
  if (!Number.isFinite(perSecond) || perSecond === 0) return '0/s';
  if (perSecond >= 1) return `${trim(perSecond.toFixed(1))}/s`;
  const perMinute = perSecond * 60;
  if (perMinute >= 1) return `${trim(perMinute.toFixed(1))}/min`;
  return `${trim((perMinute * 60).toFixed(1))}/h`;
}

export function shortId(id: string, length = 8): string {
  return id.slice(0, length);
}
