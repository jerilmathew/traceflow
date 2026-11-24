/**
 * Deterministic background traffic: a seeded PRNG picks scenarios with a
 * realistic mix (mostly healthy, some slow, a few failures) so dashboards and
 * percentiles have something real to aggregate.
 *
 *   pnpm demo:traffic -- --duration 60 --rps 4 --seed 42
 */
import { parseArgs } from 'node:util';
import { GATEWAY_URL } from '../common/config';
import { runTraffic } from './traffic-lib';

const { values } = parseArgs({
  options: {
    duration: { type: 'string', default: '60' },
    rps: { type: 'string', default: '4' },
    seed: { type: 'string', default: '42' },
  },
});
const durationS = Number(values.duration);
const rps = Number(values.rps);

console.log(`Sending ~${rps} req/s to ${GATEWAY_URL} for ${durationS}s (seed ${values.seed})`);
const counts = await runTraffic({ durationS, rps, seed: Number(values.seed) });
console.log('Responses by status:', Object.fromEntries([...counts.entries()].sort()));
