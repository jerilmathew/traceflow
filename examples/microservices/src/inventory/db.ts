import { createRequire } from 'node:module';
import type * as Pg from 'pg';
import type { Pool as PgPool } from 'pg';
import { INVENTORY_DATABASE_URL } from '../common/config';

// pg is a CommonJS package; loading it through `require` guarantees the
// OpenTelemetry pg instrumentation (require-in-the-middle) patches it.
const require = createRequire(import.meta.url);
const { Pool } = require('pg') as typeof Pg;

export const pool: PgPool = new Pool({ connectionString: INVENTORY_DATABASE_URL, max: 10 });

export interface Item {
  sku: string;
  name: string;
  warehouse: 'main' | 'cold-storage';
  on_hand: number;
  price_cents: number;
}

/**
 * Schema + seed data. `on_hand >= 0` is enforced by a CHECK constraint, which
 * is what turns the deliberately unguarded oversell in Scenario C into a real
 * database error.
 */
export async function migrateInventory(): Promise<void> {
  await pool.query(`
    create table if not exists items (
      sku text primary key,
      name text not null,
      warehouse text not null default 'main',
      on_hand integer not null,
      price_cents integer not null,
      constraint on_hand_non_negative check (on_hand >= 0)
    );
    insert into items (sku, name, warehouse, on_hand, price_cents) values
      ('KB-001', 'Mechanical Keyboard', 'main', 1000000, 12900),
      ('MS-002', 'Wireless Mouse', 'main', 1000000, 4900),
      ('MON-4K-27', '27" 4K Monitor', 'cold-storage', 1000000, 44900),
      ('GPU-RTX-01', 'Graphics Card (limited)', 'main', 3, 159900)
    on conflict (sku) do update set on_hand = greatest(items.on_hand, excluded.on_hand);
  `);
}
