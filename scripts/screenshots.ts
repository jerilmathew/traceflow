/**
 * Captures README screenshots from the *running* dev stack (real data only).
 *
 *   pnpm dev & pnpm demo:services & pnpm demo:traffic   # generate telemetry
 *   pnpm screenshots
 */
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WEB = process.env.TRACEFLOW_WEB_URL ?? 'http://127.0.0.1:5180';
const API = process.env.TRACEFLOW_API_URL ?? 'http://127.0.0.1:4400';
// fileURLToPath (not URL.pathname) so paths with spaces aren't percent-encoded.
const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));

interface TraceSummary {
  traceId: string;
  durationMs: number;
  status: string;
  rootOperation: string | null;
  spanCount: number;
}

async function findTrace(query: string): Promise<TraceSummary> {
  const res = await fetch(`${API}/api/traces?${query}`);
  const body = (await res.json()) as { items: TraceSummary[] };
  const trace = body.items.find((t) => t.rootOperation === 'POST /checkout' && t.spanCount >= 14);
  if (!trace) throw new Error(`no trace for ${query}; generate traffic first`);
  return trace;
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const shot = async (name: string, path: string, prepare?: () => Promise<void>) => {
  await page.goto(`${WEB}${path}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(800);
  await prepare?.();
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`✓ ${name}.png`);
};

const slow = await findTrace('sort=duration&order=desc&status=ok&pageSize=20');
const failed = await findTrace('status=error&pageSize=20');

await shot('overview', '/?window=15m');
await shot('traces', '/traces?range=15m');
await shot('trace-slow', `/traces/${slow.traceId}`, async () => {
  const detail = (await (await fetch(`${API}/api/traces/${slow.traceId}`)).json()) as {
    spans: Array<{ spanId: string; operationName: string; parentSpanId: string | null }>;
  };
  const check = detail.spans.find((s) => s.operationName === 'cold-storage.availability-check');
  const query = detail.spans.find((s) => s.parentSpanId === check?.spanId);
  if (query) {
    await page.locator(`[data-span-id="${query.spanId}"]`).click();
    await page.waitForTimeout(300);
  }
});
await shot('trace-error', `/traces/${failed.traceId}`, async () => {
  await page.getByRole('button', { name: 'Critical path' }).click();
  const row = page
    .locator('[data-testid="span-row"][data-error]')
    .filter({ hasText: 'reserve-stock' })
    .first();
  await row.click();
  await page.waitForTimeout(300);
});
await shot('service-map', '/map?window=15m');
await shot('service-detail', '/services/inventory-service?window=15m');

await browser.close();
