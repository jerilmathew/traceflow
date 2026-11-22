import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import type { TraceDetail } from '@traceflow/shared';
import { SCENARIOS, type Scenario } from '../examples/microservices/src/scripts/scenarios-def';

export const GATEWAY = 'http://127.0.0.1:18101';
export const API = 'http://127.0.0.1:14400';

export const scenario = (id: Scenario['id']) => SCENARIOS.find((s) => s.id === id)!;

/** Send a real request through the instrumented gateway and return its trace id. */
export async function runScenario(request: APIRequestContext, id: Scenario['id']): Promise<string> {
  const s = scenario(id);
  const res = await request.post(`${GATEWAY}/checkout`, { data: s.body });
  expect(res.status()).toBe(s.expectedStatus);
  const traceId = res.headers()['x-trace-id'];
  expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  return traceId!;
}

/**
 * Spans of one trace are exported by three processes in independent
 * batches; wait until the stored trace has at least `minSpans` spans and
 * the count has stopped changing.
 */
export async function waitForTrace(
  request: APIRequestContext,
  traceId: string,
  minSpans: number,
): Promise<TraceDetail> {
  let last = -1;
  let detail: TraceDetail | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${API}/api/traces/${traceId}`);
        if (!res.ok()) return false;
        detail = (await res.json()) as TraceDetail;
        const stable = detail.spans.length >= minSpans && detail.spans.length === last;
        last = detail.spans.length;
        return stable;
      },
      { timeout: 20_000, intervals: [300, 500, 700] },
    )
    .toBe(true);
  return detail!;
}
