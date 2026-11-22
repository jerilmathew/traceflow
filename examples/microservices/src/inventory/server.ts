/**
 * Inventory Service — owns stock levels in its own PostgreSQL database.
 *
 *   GET  /items/:sku      → item + availability
 *   POST /reservations    → reserve stock for an order
 *
 * Every query is a real `pg` call, so TraceFlow shows genuine database spans.
 */
import { withSpan } from '@traceflow/telemetry';
import { COLD_STORAGE_DELAY_MS, HOST, INVENTORY_PORT } from '../common/config';
import { HttpError, createServer } from '../common/http';
import { migrateInventory, pool, type Item } from './db';

const app = createServer('inventory-service');

async function findItem(sku: string): Promise<Item> {
  const { rows } = await pool.query<Item>(
    'select sku, name, warehouse, on_hand, price_cents from items where sku = $1',
    [sku],
  );
  const item = rows[0];
  if (!item) throw new HttpError(404, `unknown sku ${sku}`, 'unknown_sku');
  return item;
}

app.get<{ Params: { sku: string } }>('/items/:sku', async (request) => {
  const item = await findItem(request.params.sku);
  return { ...item, available: item.on_hand > 0 };
});

app.post<{ Body: { sku?: string; quantity?: number; orderId?: string } }>('/reservations', async (request) => {
  const { sku, quantity, orderId } = request.body ?? {};
  if (!sku || !Number.isInteger(quantity) || (quantity as number) <= 0) {
    throw new HttpError(400, 'sku and a positive integer quantity are required', 'invalid_reservation');
  }
  const qty = quantity as number;
  const item = await findItem(sku);

  // Scenario B: cold-storage items need a cross-warehouse availability check.
  // The delay is a controlled, configurable pg_sleep inside a real query, so
  // the bottleneck shows up where it would in production: in a DB span.
  if (item.warehouse === 'cold-storage') {
    await withSpan('cold-storage.availability-check', { 'inventory.warehouse': item.warehouse }, () =>
      pool.query('select pg_sleep($1::float8 / 1000) as waited, $2::text as sku', [COLD_STORAGE_DELAY_MS, sku]),
    );
  }

  // Scenario C: this reservation is deliberately *not* guarded by an
  // application-level stock check. Over-reserving violates the
  // `on_hand_non_negative` CHECK constraint, PostgreSQL rejects the UPDATE,
  // the transaction rolls back, and the error propagates as a 500.
  const reservation = await withSpan(
    'inventory.reserve-stock',
    { 'inventory.sku': sku, 'inventory.quantity': qty },
    async () => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query<{ on_hand: number }>(
          'update items set on_hand = on_hand - $2 where sku = $1 returning on_hand',
          [sku, qty],
        );
        await client.query('commit');
        return { sku, quantity: qty, remaining: rows[0]!.on_hand };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  return { reservationId: `res_${orderId ?? Date.now().toString(36)}`, ...reservation, unitPriceCents: item.price_cents };
});

await migrateInventory();
await app.listen({ host: HOST, port: INVENTORY_PORT });
console.log(`inventory-service listening on http://${HOST}:${INVENTORY_PORT}`);
