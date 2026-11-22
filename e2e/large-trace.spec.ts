import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * Performance guard: a synthetic 5,000-span trace (clearly test data, sent
 * straight to the collector) must render quickly with a virtualised list.
 */
test('a 5,000-span trace renders without freezing the UI', async ({ page, request }) => {
  const traceId = randomBytes(16).toString('hex');
  const base = BigInt(Date.now() - 10_000) * 1_000_000n;
  const ns = (ms: number) => (base + BigInt(Math.round(ms * 1e6))).toString();
  const rootId = randomBytes(8).toString('hex');
  const spans = [
    {
      traceId,
      spanId: rootId,
      name: 'batch.job',
      kind: 2,
      startTimeUnixNano: ns(0),
      endTimeUnixNano: ns(5000),
    },
  ];
  let parent = rootId;
  for (let i = 1; i < 5000; i++) {
    const spanId = randomBytes(8).toString('hex');
    spans.push({
      traceId,
      spanId,
      parentSpanId: i % 50 === 0 ? rootId : parent,
      name: `step-${i}`,
      kind: 1,
      startTimeUnixNano: ns(i),
      endTimeUnixNano: ns(i + 3),
    } as never);
    parent = i % 50 === 0 ? rootId : spanId;
  }
  const res = await request.post('http://127.0.0.1:14318/v1/traces', {
    data: {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'synthetic-load-test' } }],
          },
          scopeSpans: [{ spans }],
        },
      ],
    },
  });
  expect(res.status()).toBe(200);

  const started = Date.now();
  await page.goto(`/traces/${traceId}`);
  await expect(page.getByTestId('trace-spans')).toHaveText('5000');
  await expect(page.getByTestId('span-row').first()).toBeVisible();
  expect(Date.now() - started).toBeLessThan(8_000);

  // Virtualisation: only a window of rows exists in the DOM.
  expect(await page.getByTestId('span-row').count()).toBeLessThan(150);

  // Scrolling to the end stays responsive and renders the deepest rows.
  await page
    .getByRole('tree', { name: 'Trace spans' })
    .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator('[data-testid="span-row"]').last()).toBeVisible();
});
