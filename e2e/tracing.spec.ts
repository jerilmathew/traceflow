import { expect, test } from '@playwright/test';
import { API, GATEWAY, runScenario, waitForTrace } from './helpers';

test.describe('distributed tracing, end to end', () => {
  test('Scenario A: a healthy checkout appears live and its waterfall shows cross-service links', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('status').getByText('Live')).toBeVisible();

    const traceId = await runScenario(request, 'A');

    // The overview's recent-traces table updates over SSE without a reload.
    await expect(
      page.locator(`[data-testid="trace-row"][data-trace-id="${traceId}"]`),
    ).toBeVisible();

    const detail = await waitForTrace(request, traceId, 15);
    // Every span belongs to the same trace (W3C traceparent propagated across processes).
    expect(new Set(detail.spans.map((s) => s.traceId))).toEqual(new Set([traceId]));
    expect(detail.trace.services).toEqual(['api-gateway', 'inventory-service', 'users-service']);

    // Open the trace from the explorer.
    await page.goto('/traces');
    await page.locator(`[data-trace-id="${traceId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/traces/${traceId}`));
    await expect(page.getByTestId('trace-title')).toHaveText('POST /checkout');
    await expect(page.getByTestId('trace-spans')).toHaveText(String(detail.spans.length));

    const rows = page.getByTestId('span-row');
    await expect(rows).toHaveCount(detail.spans.length);
    await expect(rows.first()).toHaveAttribute('data-service', 'api-gateway');
    await expect(rows.first()).toHaveAttribute('data-depth', '0');

    // Cross-service parent/child: the users-service SERVER span is the child of
    // the gateway's CLIENT span, one level deeper, directly below it.
    const clientSpan = detail.spans.find(
      (s) =>
        s.service === 'api-gateway' && s.kind === 'client' && s.operationName === 'GET /users/:id',
    )!;
    const serverSpan = detail.spans.find(
      (s) => s.service === 'users-service' && s.kind === 'server',
    )!;
    expect(serverSpan.parentSpanId).toBe(clientSpan.spanId);
    const clientRow = page.locator(`[data-span-id="${clientSpan.spanId}"]`);
    const serverRow = page.locator(`[data-span-id="${serverSpan.spanId}"]`);
    const clientDepth = Number(await clientRow.getAttribute('data-depth'));
    await expect(serverRow).toHaveAttribute('data-depth', String(clientDepth + 1));

    // Inspect the downstream span: same trace id, parent id = gateway client span.
    await serverRow.click();
    const inspector = page.getByTestId('span-inspector');
    await expect(inspector).toContainText('GET /users/:id');
    await expect(inspector).toContainText(traceId);
    await expect(inspector).toContainText(clientSpan.spanId);
    await expect(page.locator('[data-error]')).toHaveCount(0);
  });

  test('Scenario B: the slow inventory dependency is identifiable as the bottleneck', async ({
    page,
    request,
  }) => {
    const traceId = await runScenario(request, 'B');
    const detail = await waitForTrace(request, traceId, 17);
    expect(detail.trace.durationMs).toBeGreaterThan(400);

    const slowest = [...detail.spans].sort((a, b) => b.durationMs - a.durationMs);
    // Root, then the gateway's call and inventory's handler, then the slow work itself.
    const coldCheck = detail.spans.find(
      (s) => s.operationName === 'cold-storage.availability-check',
    )!;
    const slowQuery = detail.spans.find((s) => s.parentSpanId === coldCheck.spanId)!;
    expect(slowQuery.service).toBe('inventory-service');
    expect(slowQuery.durationMs).toBeGreaterThan(400);
    expect(slowQuery.attributes['db.query.text'] ?? slowQuery.attributes['db.statement']).toMatch(
      /pg_sleep/,
    );
    expect(slowest.slice(0, 5).map((s) => s.spanId)).toContain(slowQuery.spanId);

    await page.goto(`/traces/${traceId}`);
    await expect(page.getByTestId('trace-title')).toHaveText('POST /checkout');

    // Time-by-service attributes most of the request to inventory-service.
    await expect(page.getByText('Time by service')).toBeVisible();
    const share = page.locator('li', { hasText: 'inventory-service' }).first();
    await expect(share).toContainText(/9\d%|8\d%/);

    // The slow query is on the critical path, and stays highlighted when non-critical spans are dimmed.
    const queryRow = page.locator(`[data-span-id="${slowQuery.spanId}"]`);
    await expect(queryRow).toHaveAttribute('data-critical', 'true');
    await page.getByRole('button', { name: 'Critical path' }).click();
    await expect(page.getByRole('button', { name: 'Critical path' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Its bar is visibly the widest child: > 80% of the timeline width.
    const bar = queryRow.getByTestId('span-bar');
    const rootBar = page.getByTestId('span-row').first().getByTestId('span-bar');
    const [barBox, rootBox] = [await bar.boundingBox(), await rootBar.boundingBox()];
    expect(barBox!.width / rootBox!.width).toBeGreaterThan(0.8);

    await queryRow.click();
    await expect(page.getByTestId('span-inspector')).toContainText('pg_sleep');
  });

  test('Scenario C: a failed request carries error status and exception events', async ({
    page,
    request,
  }) => {
    const traceId = await runScenario(request, 'C');
    const detail = await waitForTrace(request, traceId, 14);
    expect(detail.trace.status).toBe('error');

    const failedUpdate = detail.spans.find((s) => s.operationName.startsWith('pg.query:UPDATE'))!;
    expect(failedUpdate.statusCode).toBe('error');
    expect(failedUpdate.statusMessage).toMatch(/on_hand_non_negative/);
    const reserve = detail.spans.find((s) => s.operationName === 'inventory.reserve-stock')!;
    expect(reserve.events.some((e) => e.name === 'exception')).toBe(true);

    await page.goto(`/traces/${traceId}`);
    await expect(page.getByText(/^Error/).first()).toBeVisible();

    // Error indicators propagate from the database span up to the gateway root.
    const errorRows = page.locator('[data-testid="span-row"][data-error]');
    await expect(errorRows).toHaveCount(
      detail.spans.filter((s) => s.statusCode === 'error').length,
    );
    await expect(page.locator(`[data-span-id="${failedUpdate.spanId}"]`)).toHaveAttribute(
      'data-error',
      'true',
    );
    await expect(page.getByTestId('span-row').first()).toHaveAttribute('data-error', 'true');

    await page.locator(`[data-span-id="${reserve.spanId}"]`).click();
    const inspector = page.getByTestId('span-inspector');
    await expect(inspector).toContainText('Status message');
    await expect(inspector).toContainText('on_hand_non_negative');
    await expect(inspector).toContainText('exception');
  });

  test('the explorer filters by status and the service map shows observed dependencies', async ({
    page,
    request,
  }) => {
    const ok = await runScenario(request, 'A');
    const failed = await runScenario(request, 'C');
    await waitForTrace(request, ok, 15);
    await waitForTrace(request, failed, 14);

    await page.goto('/traces');
    await page.getByRole('radio', { name: 'Errors' }).click();
    await expect(page).toHaveURL(/status=error/);
    await expect(page.locator(`[data-trace-id="${failed}"]`)).toBeVisible();
    await expect(page.locator(`[data-trace-id="${ok}"]`)).toHaveCount(0);

    await page.getByLabel('Search by trace id, operation or service').fill(failed.slice(0, 12));
    await expect(page.getByTestId('trace-row')).toHaveCount(1);

    await page.goto('/map?window=15m');
    await expect(
      page.locator('[data-testid="map-node"][data-node-id="api-gateway"]'),
    ).toBeVisible();
    await expect(page.locator('[data-edge="api-gateway->users-service"]')).toBeVisible();
    await expect(page.locator('[data-edge="api-gateway->inventory-service"]')).toBeVisible();
    await expect(
      page.locator('[data-edge="inventory-service->postgresql:inventory_demo"]'),
    ).toBeVisible();
    // No invented edges: users-service never calls the database.
    await expect(page.locator('[data-edge^="users-service->"]')).toHaveCount(0);
  });

  test('the API health endpoint and demo gateway are wired to the isolated stack', async ({
    request,
  }) => {
    expect((await request.get(`${API}/api/health`)).ok()).toBe(true);
    expect((await request.get(`${GATEWAY}/health`)).ok()).toBe(true);
  });
});
