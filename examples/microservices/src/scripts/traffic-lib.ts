import { GATEWAY_URL } from '../common/config';
import { SCENARIOS, runScenario } from './scenarios-def';

/** mulberry32: tiny, fast, seedable PRNG → same seed, same request sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const USERS = ['user-1001', 'user-1002', 'user-1003'];
const HEALTHY_SKUS = ['KB-001', 'MS-002'];

function nextRequest(random: () => number) {
  const roll = random();
  const userId = USERS[Math.floor(random() * USERS.length)]!;
  if (roll < 0.8)
    return {
      ...SCENARIOS[0]!,
      body: {
        userId,
        sku: HEALTHY_SKUS[Math.floor(random() * 2)]!,
        quantity: 1 + Math.floor(random() * 3),
      },
    };
  if (roll < 0.93) return { ...SCENARIOS[1]!, body: { ...SCENARIOS[1]!.body, userId } };
  if (roll < 0.97) return SCENARIOS[2]!;
  // A suspended account: a handled 403, not a server error.
  return { ...SCENARIOS[0]!, body: { userId: 'user-2001', sku: 'KB-001', quantity: 1 } };
}

export interface TrafficOptions {
  durationS: number;
  rps: number;
  seed: number;
  shouldStop?: () => boolean;
}

/** Send a seeded, realistic mix of requests; resolves with response counts by status. */
export async function runTraffic(options: TrafficOptions): Promise<Map<number, number>> {
  const random = mulberry32(options.seed);
  const counts = new Map<number, number>();
  const inflight = new Set<Promise<void>>();
  const end = Date.now() + options.durationS * 1000;
  while (Date.now() < end && !options.shouldStop?.()) {
    const p = runScenario(GATEWAY_URL, nextRequest(random))
      .then((r) => void counts.set(r.status, (counts.get(r.status) ?? 0) + 1))
      .catch(() => void counts.set(0, (counts.get(0) ?? 0) + 1))
      .finally(() => inflight.delete(p));
    inflight.add(p);
    await new Promise((r) => setTimeout(r, 1000 / options.rps));
  }
  await Promise.all(inflight);
  return counts;
}
