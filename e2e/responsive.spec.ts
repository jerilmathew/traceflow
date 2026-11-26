import { expect, test } from '@playwright/test';
import { runScenario, waitForTrace } from './helpers';

for (const [label, width, height] of [
  ['phone', 390, 844],
  ['tablet', 820, 1100],
  ['desktop', 1440, 900],
] as const) {
  test(`dashboard is usable without sign-up at ${label} size`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    const traceId = await runScenario(request, 'C');
    await waitForTrace(request, traceId, 14);

    for (const path of [
      '/',
      '/traces',
      `/traces/${traceId}`,
      '/map',
      '/services',
      '/services/inventory-service',
    ]) {
      await page.goto(path);
      await expect(page.getByTestId('demo-notice')).toContainText('Demo environment');
      await expect(page.locator('h1')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    }

    // The time selector must not be covered by the cards below it.
    await page.goto('/');
    await page.getByLabel('Time window').last().selectOption('15m');
    await expect(page).toHaveURL(/window=15m/);

    // The waterfall timeline stays wide enough to compare spans.
    await page.goto(`/traces/${traceId}`);
    const bar = await page.getByTestId('span-row').first().getByTestId('span-bar').boundingBox();
    expect(bar!.width).toBeGreaterThan(250);
    await page.getByTestId('span-row').nth(1).click();
    await expect(page.getByTestId('span-inspector')).toBeVisible();
  });
}
