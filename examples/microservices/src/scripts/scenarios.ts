/**
 * Runs scenarios A, B and C once each, then (if the TraceFlow API is up)
 * waits until every trace has been ingested and prints a link to it.
 *
 *   pnpm demo            # all scenarios
 *   pnpm demo B          # just one
 */
import { GATEWAY_URL } from '../common/config';
import { SCENARIOS, runScenario } from './scenarios-def';

const API_URL = process.env.TRACEFLOW_API_URL ?? 'http://127.0.0.1:4400';
const WEB_URL = process.env.TRACEFLOW_WEB_URL ?? 'http://localhost:5180';

const only = process.argv.slice(2).map((a) => a.toUpperCase());
const selected = SCENARIOS.filter((s) => only.length === 0 || only.includes(s.id));

async function waitForTrace(traceId: string, timeoutMs = 10_000): Promise<{ spanCount: number; services: string[]; status: string } | null> {
  const deadline = Date.now() + timeoutMs;
  let last: { spanCount: number; services: string[]; status: string } | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_URL}/api/traces/${traceId}`);
      if (res.ok) {
        const body = (await res.json()) as { trace: { spanCount: number; services: string[]; status: string } };
        // Spans from three processes arrive in separate batches: wait until the count settles.
        if (last && last.spanCount === body.trace.spanCount) return body.trace;
        last = body.trace;
      }
    } catch {
      return null; // API not running
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return last;
}

let failures = 0;
for (const scenario of selected) {
  const result = await runScenario(GATEWAY_URL, scenario).catch((error: Error) => {
    console.error(`✗ Scenario ${scenario.id}: gateway unreachable at ${GATEWAY_URL} (${error.message}). Run \`pnpm demo:services\` first.`);
    process.exit(1);
  });
  const ok = result.status === scenario.expectedStatus;
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} Scenario ${scenario.id} — ${scenario.name}: HTTP ${result.status} in ${result.latencyMs.toFixed(0)}ms` +
      (ok ? '' : ` (expected ${scenario.expectedStatus})`),
  );
  console.log(`    ${scenario.description}`);
  if (!result.traceId) {
    console.log('    (no x-trace-id header — is the gateway instrumented?)');
    continue;
  }
  const trace = await waitForTrace(result.traceId);
  if (trace) {
    console.log(`    trace ${result.traceId}: ${trace.spanCount} spans, services [${trace.services.join(', ')}], status ${trace.status}`);
  } else {
    console.log(`    trace ${result.traceId} (TraceFlow API not reachable at ${API_URL}; start it with \`pnpm dev\`)`);
  }
  console.log(`    ${WEB_URL}/traces/${result.traceId}\n`);
}
process.exit(failures === 0 ? 0 : 1);
