import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * A logical service, identified by the OpenTelemetry resource attributes
 * `service.name` + `deployment.environment(.name)`.
 */
export const services = pgTable(
  'services',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    /** Empty string when the resource did not declare an environment. */
    environment: text('environment').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('services_name_env_uq').on(t.name, t.environment)],
);

/**
 * One row per trace: a summary that is *derived* from the trace's spans and
 * recomputed every time new spans for the trace are ingested (see
 * apps/collector/src/ingest.ts). It exists so the trace list and dashboards
 * never have to aggregate the spans table on the fly.
 */
export const traces = pgTable(
  'traces',
  {
    /** 32 lowercase hex chars (16 bytes), as in W3C `traceparent`. */
    traceId: char('trace_id', { length: 32 }).primaryKey(),
    rootServiceId: integer('root_service_id').references(() => services.id),
    rootService: text('root_service'),
    rootOperation: text('root_operation'),
    rootSpanId: char('root_span_id', { length: 16 }),
    /** True once a span without a parent has been seen. */
    hasRoot: boolean('has_root').notNull().default(false),
    startTime: timestamp('start_time', { withTimezone: true, precision: 6 }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true, precision: 6 }).notNull(),
    /** Exact OTLP nanosecond timestamps; `mode: 'bigint'` keeps full precision. */
    startUnixNano: bigint('start_unix_nano', { mode: 'bigint' }).notNull(),
    endUnixNano: bigint('end_unix_nano', { mode: 'bigint' }).notNull(),
    durationMs: doublePrecision('duration_ms').notNull(),
    /** 'ok' | 'error' — a trace is an error trace if any span has ERROR status. */
    status: text('status').notNull(),
    spanCount: integer('span_count').notNull(),
    errorCount: integer('error_count').notNull(),
    orphanCount: integer('orphan_count').notNull().default(0),
    services: text('services').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('traces_start_time_idx').on(t.startTime.desc()),
    index('traces_root_service_start_idx').on(t.rootService, t.startTime.desc()),
    index('traces_duration_idx').on(t.durationMs.desc()),
    index('traces_errors_start_idx')
      .on(t.startTime.desc())
      .where(sql`${t.status} = 'error'`),
    // GIN index answers "traces that touched service X" (services @> ARRAY['x']).
    index('traces_services_gin_idx').using('gin', t.services),
  ],
);

export const spans = pgTable(
  'spans',
  {
    traceId: char('trace_id', { length: 32 }).notNull(),
    spanId: char('span_id', { length: 16 }).notNull(),
    parentSpanId: char('parent_span_id', { length: 16 }),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id),
    operationName: text('operation_name').notNull(),
    /** OTLP SpanKind enum value: 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer. */
    kind: smallint('kind').notNull(),
    startTime: timestamp('start_time', { withTimezone: true, precision: 6 }).notNull(),
    startUnixNano: bigint('start_unix_nano', { mode: 'bigint' }).notNull(),
    endUnixNano: bigint('end_unix_nano', { mode: 'bigint' }).notNull(),
    durationMs: doublePrecision('duration_ms').notNull(),
    /** OTLP StatusCode: 0 unset, 1 ok, 2 error. */
    statusCode: smallint('status_code').notNull(),
    statusMessage: text('status_message'),
    /** Error classification computed once at ingest (see collector isErrorSpan). */
    isError: boolean('is_error').notNull().default(false),
    attributes: jsonb('attributes').notNull().default({}),
    resourceAttributes: jsonb('resource_attributes').notNull().default({}),
    events: jsonb('events').notNull().default([]),
    links: jsonb('links').notNull().default([]),
    scopeName: text('scope_name'),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // (trace_id, span_id) is the natural identity of a span and the
    // idempotency key that makes duplicate submissions harmless.
    primaryKey({ name: 'spans_pkey', columns: [t.traceId, t.spanId] }),
    index('spans_service_start_idx').on(t.serviceId, t.startTime.desc()),
    index('spans_start_time_idx').on(t.startTime.desc()),
    // Supports the parent→child self-join used to derive service dependencies.
    index('spans_trace_parent_idx').on(t.traceId, t.parentSpanId),
  ],
);

export type ServiceRow = typeof services.$inferSelect;
export type TraceRow = typeof traces.$inferSelect;
export type SpanRow = typeof spans.$inferSelect;
export type NewSpanRow = typeof spans.$inferInsert;
