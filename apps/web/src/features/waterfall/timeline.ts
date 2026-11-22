/** Pure helpers for the waterfall timeline (kept separate so they're trivially testable). */

export interface ViewRange {
  start: number;
  end: number;
}

/** "Nice" tick step (1, 2, 5 × 10^k) giving roughly `target` ticks across `span` ms. */
export function niceStep(span: number, target = 6): number {
  if (!(span > 0)) return 1;
  const raw = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return nice * magnitude;
}

export function ticks(view: ViewRange, target = 6): number[] {
  const span = view.end - view.start;
  const step = niceStep(span, target);
  const first = Math.ceil(view.start / step) * step;
  const out: number[] = [];
  for (let t = first; t <= view.end + step * 1e-9; t += step) out.push(Number(t.toFixed(9)));
  return out;
}

/** Horizontal placement of an interval within the view, as percentages (clamped). */
export function placement(
  offsetMs: number,
  durationMs: number,
  view: ViewRange,
): { left: number; width: number; visible: boolean } {
  const span = Math.max(view.end - view.start, 1e-9);
  const start = (offsetMs - view.start) / span;
  const end = (offsetMs + durationMs - view.start) / span;
  const visible = end >= 0 && start <= 1;
  const left = Math.min(Math.max(start, 0), 1) * 100;
  const right = Math.min(Math.max(end, 0), 1) * 100;
  return { left, width: Math.max(right - left, 0), visible };
}
