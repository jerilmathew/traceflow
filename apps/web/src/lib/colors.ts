/**
 * Categorical service colors (dark surface). The order was validated with the
 * dataviz palette checker against #101014: every adjacent pair clears the CVD
 * ΔE ≥ 8 target and the normal-vision floor, and every slot has ≥ 3:1
 * contrast. Red and green are deliberately absent — they are reserved for
 * error / healthy state.
 *
 * Colors follow the *entity*: a service keeps its color across every page
 * and every trace because the slot is derived from a hash of its name, never
 * from its position in a list.
 */
export const SERVICE_PALETTE = [
  '#9085e9',
  '#199e70',
  '#d95926',
  '#3987e5',
  '#c98500',
  '#d55181',
] as const;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const cache = new Map<string, string>();
export function serviceColor(name: string): string {
  let color = cache.get(name);
  if (!color) {
    color = SERVICE_PALETTE[fnv1a(name) % SERVICE_PALETTE.length]!;
    cache.set(name, color);
  }
  return color;
}

export const STATUS_COLORS = { ok: '#30a46c', warn: '#f5a524', err: '#e5484d' } as const;
