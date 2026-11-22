/**
 * The three reproducible demo scenarios. Each one is an ordinary request to
 * the API Gateway; the behaviour comes from the services' real code paths.
 */
export interface Scenario {
  id: 'A' | 'B' | 'C';
  name: string;
  description: string;
  body: { userId: string; sku: string; quantity: number };
  expectedStatus: number;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'A',
    name: 'Healthy checkout',
    description: 'Gateway → Users + Inventory (concurrently) → reservation → total. All spans OK.',
    body: { userId: 'user-1001', sku: 'KB-001', quantity: 1 },
    expectedStatus: 200,
  },
  {
    id: 'B',
    name: 'Slow downstream dependency',
    description:
      'The monitor lives in cold storage: Inventory runs a slow availability query (pg_sleep, COLD_STORAGE_DELAY_MS=450 by default).',
    body: { userId: 'user-1002', sku: 'MON-4K-27', quantity: 1 },
    expectedStatus: 200,
  },
  {
    id: 'C',
    name: 'Failed request',
    description:
      'Over-reserving a limited GPU violates the on_hand_non_negative CHECK constraint; the DB error propagates up as Inventory 500 → Gateway 502.',
    body: { userId: 'user-1001', sku: 'GPU-RTX-01', quantity: 50 },
    expectedStatus: 502,
  },
];

export interface ScenarioResult {
  scenario: Scenario;
  status: number;
  traceId: string | null;
  latencyMs: number;
}

export async function runScenario(gatewayUrl: string, scenario: Scenario): Promise<ScenarioResult> {
  const started = performance.now();
  const response = await fetch(`${gatewayUrl}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scenario.body),
  });
  await response.arrayBuffer();
  return {
    scenario,
    status: response.status,
    traceId: response.headers.get('x-trace-id'),
    latencyMs: performance.now() - started,
  };
}
