/**
 * API Gateway — the public entry point. Fans out to the User and Inventory
 * services over real HTTP, propagating W3C Trace Context on every call.
 *
 *   POST /checkout         { userId, sku, quantity }
 *   GET  /products/:sku
 */
import { randomUUID } from 'node:crypto';
import { tracedFetch, withSpan } from '@traceflow/telemetry';
import { GATEWAY_PORT, HOST, INVENTORY_URL, USERS_URL } from '../common/config';
import { HttpError, createServer } from '../common/http';

interface UserResponse {
  id: string;
  status: string;
  tier: string;
  limits: { maxItemsPerOrder: number; canCheckout: boolean };
}
interface ItemResponse {
  sku: string;
  name: string;
  price_cents: number;
  available: boolean;
}
interface ReservationResponse {
  reservationId: string;
  remaining: number;
  unitPriceCents: number;
}

/** Call a downstream service; non-2xx responses become HttpErrors with the callee's message. */
async function callJson<T>(
  url: string,
  peerService: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await tracedFetch(url, {
    ...init,
    peerService,
    spanName: `${(init.method ?? 'GET').toUpperCase()} ${route}`,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
  if (!response.ok) {
    // Downstream 5xx → 502 Bad Gateway; downstream 4xx is passed through.
    const status = response.status >= 500 ? 502 : response.status;
    throw new HttpError(
      status,
      `${peerService} responded ${response.status}: ${body.error?.message ?? 'no details'}`,
      body.error?.code ?? 'downstream_error',
    );
  }
  return body as T;
}

const app = createServer('api-gateway');

app.post<{ Body: { userId?: string; sku?: string; quantity?: number } }>('/checkout', async (request) => {
  const orderId = randomUUID();

  const input = await withSpan('checkout.validate-request', {}, () => {
    const { userId, sku, quantity = 1 } = request.body ?? {};
    if (typeof userId !== 'string' || typeof sku !== 'string' || !Number.isInteger(quantity) || quantity <= 0) {
      throw new HttpError(400, 'userId, sku and a positive integer quantity are required', 'invalid_request');
    }
    return { userId, sku, quantity };
  });

  // Independent lookups run concurrently: the waterfall shows them overlapping.
  const [user, item] = await Promise.all([
    callJson<UserResponse>(`${USERS_URL}/users/${encodeURIComponent(input.userId)}`, 'users-service', '/users/:id'),
    callJson<ItemResponse>(`${INVENTORY_URL}/items/${encodeURIComponent(input.sku)}`, 'inventory-service', '/items/:sku'),
  ]);

  if (!user.limits.canCheckout) throw new HttpError(403, `account ${user.id} is ${user.status}`, 'account_inactive');
  if (input.quantity > user.limits.maxItemsPerOrder) {
    throw new HttpError(422, `quantity exceeds the ${user.limits.maxItemsPerOrder}-item limit for ${user.tier} accounts`, 'limit_exceeded');
  }

  const reservation = await callJson<ReservationResponse>(`${INVENTORY_URL}/reservations`, 'inventory-service', '/reservations', {
    method: 'POST',
    body: JSON.stringify({ sku: input.sku, quantity: input.quantity, orderId }),
  });

  const total = await withSpan('checkout.calculate-total', { 'order.quantity': input.quantity }, (span) => {
    const subtotal = reservation.unitPriceCents * input.quantity;
    const discount = user.tier === 'plus' ? Math.round(subtotal * 0.05) : 0;
    const tax = Math.round((subtotal - discount) * 0.2);
    span.setAttribute('order.total_cents', subtotal - discount + tax);
    return { subtotal, discount, tax, total: subtotal - discount + tax };
  });

  return { orderId, status: 'confirmed', item: item.name, reservationId: reservation.reservationId, amountCents: total };
});

app.get<{ Params: { sku: string } }>('/products/:sku', async (request) =>
  callJson<ItemResponse>(
    `${INVENTORY_URL}/items/${encodeURIComponent(request.params.sku)}`,
    'inventory-service',
    '/items/:sku',
  ),
);

await app.listen({ host: HOST, port: GATEWAY_PORT });
console.log(`api-gateway listening on http://${HOST}:${GATEWAY_PORT}`);
