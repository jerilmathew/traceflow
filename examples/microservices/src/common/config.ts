/** Ports and URLs for the demo services. Override with environment variables. */
const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export const HOST = process.env.DEMO_HOST ?? '127.0.0.1';
export const GATEWAY_PORT = port('GATEWAY_PORT', 8101);
export const USERS_PORT = port('USERS_PORT', 8102);
export const INVENTORY_PORT = port('INVENTORY_PORT', 8103);

export const GATEWAY_URL = process.env.GATEWAY_URL ?? `http://${HOST}:${GATEWAY_PORT}`;
export const USERS_URL = process.env.USERS_URL ?? `http://${HOST}:${USERS_PORT}`;
export const INVENTORY_URL = process.env.INVENTORY_URL ?? `http://${HOST}:${INVENTORY_PORT}`;

/** The Inventory service's own application database (not TraceFlow's). */
export const INVENTORY_DATABASE_URL =
  process.env.INVENTORY_DATABASE_URL ?? 'postgres://traceflow:traceflow@127.0.0.1:5544/inventory_demo';

/** Artificial latency of the cold-storage availability query (Scenario B). */
export const COLD_STORAGE_DELAY_MS = port('COLD_STORAGE_DELAY_MS', 450);
