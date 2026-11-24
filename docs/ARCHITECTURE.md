# TraceFlow architecture

This document explains how TraceFlow works and why it is built the way it is.
It is written to be discussed: each section states a design decision, the
alternatives, and the trade-off taken.

- [1. System overview](#1-system-overview)
- [2. Distributed tracing primer](#2-distributed-tracing-primer)
- [3. Ingestion path](#3-ingestion-path)
- [4. Data model](#4-data-model)
- [5. Trace summaries under out-of-order, duplicate and concurrent arrival](#5-trace-summaries-under-out-of-order-duplicate-and-concurrent-arrival)
- [6. Query path and analytics](#6-query-path-and-analytics)
- [7. Live updates](#7-live-updates)
- [8. The waterfall](#8-the-waterfall)
- [9. Failure handling](#9-failure-handling)
- [10. Security posture](#10-security-posture)
- [11. Testing strategy](#11-testing-strategy)
- [12. Trade-offs and what I'd do next](#12-trade-offs-and-what-id-do-next)

---

## 1. System overview

```
 ┌──────────────┐  HTTP + traceparent  ┌───────────────┐   ┌───────────────────┐
 │ api-gateway  │ ───────────────────▶ │ users-service │   │ inventory-service │──▶ PostgreSQL
 │  (Fastify)   │ ─────────────────────────────────────▶ │     (Fastify)     │   (inventory_demo)
 └──────┬───────┘                      └───────┬───────┘   └─────────┬─────────┘
        │  OpenTelemetry SDK · BatchSpanProcessor · OTLP/HTTP JSON exporter
        ▼                                      ▼                     ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ apps/collector  :4318   POST /v1/traces                                      │
 │   gunzip → parse/validate (per span) → normalize → one transaction:          │
 │   upsert services · advisory-lock traces · insert spans ON CONFLICT DO       │
 │   NOTHING · recompute trace summaries · pg_notify                            │
 └──────────────────────────────────────┬───────────────────────────────────────┘
                                        ▼
                         ┌────────────────────────────┐
                         │ PostgreSQL  traceflow       │  services · traces · spans
                         └──────────────┬─────────────┘
                     SQL (postgres.js)  │  LISTEN traceflow_ingest
                                        ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ apps/api  :4400   REST (/api/traces, /overview, /services, /dependencies)    │
 │                   SSE (/api/stream) · OpenAPI (/api/openapi.json)             │
 └──────────────────────────────────────┬───────────────────────────────────────┘
                                        ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ apps/web  :5180   React · TanStack Query · EventSource · React Flow · Recharts│
 └──────────────────────────────────────────────────────────────────────────────┘
```

| Package                  | Responsibility                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/collector`         | OTLP/HTTP JSON receiver. Owns all writes.                                                                                          |
| `apps/api`               | Read-only query API + live stream. Never writes telemetry.                                                                         |
| `apps/web`               | Dashboard. Talks only to the API (same-origin through the Vite proxy in dev, or served by the API in production mode).             |
| `packages/db`            | Drizzle schema, generated SQL migrations, connection factory.                                                                      |
| `packages/shared`        | API contracts and pure algorithms shared by server and browser (percentiles, trace-tree reconstruction, self time, critical path). |
| `packages/telemetry`     | OpenTelemetry bootstrap used by the example services (`startTelemetry`, `tracedFetch`, `withSpan`).                                |
| `examples/microservices` | Three genuinely instrumented services and deterministic scenario/traffic scripts.                                                  |

**Why separate collector and API processes?** Ingestion and querying have
different load shapes and failure modes. Exporters retry aggressively; a slow
dashboard query must never cause back-pressure on ingestion, and an ingestion
burst must not make the UI unresponsive. Splitting them also gives a clean
security boundary: only the collector writes. They share nothing but the
database schema, which `packages/db` owns.

**Why PostgreSQL for spans?** For an MVP running on a laptop, PostgreSQL gives
transactions (needed for consistent summaries), JSONB for open-ended
attributes, `percentile_cont`, `date_bin`, GIN indexes, and LISTEN/NOTIFY for
push — with one container and zero extra infrastructure. A columnar store
(ClickHouse) or object-storage design (Tempo) is the right answer at
production volumes; see [§12](#12-trade-offs-and-what-id-do-next).

---

## 2. Distributed tracing primer

A **span** is one timed operation: an HTTP handler, an outgoing call, a SQL
query. It has a 16-byte **trace id**, an 8-byte **span id**, an optional
**parent span id**, start/end timestamps in Unix nanoseconds, a kind
(server/client/internal/…), a status, attributes and events.

A **trace** is the set of spans sharing a trace id. It is a tree, but no single
process ever sees the whole tree: the gateway knows its own spans, the
inventory service knows its own. The tree only exists once a backend joins
the pieces by `parentSpanId`.

**Context propagation** is what makes the pieces joinable. When the gateway
calls the users service, `tracedFetch` (in `packages/telemetry`):

1. starts a CLIENT span as a child of the active server span;
2. calls `propagation.inject`, which writes the W3C header
   `traceparent: 00-<trace-id>-<client-span-id>-01`;
3. the users service's HTTP instrumentation extracts the header and starts its
   SERVER span with the _same trace id_ and `parentSpanId = client-span-id`.

Without propagation each service would start a new trace and you would get
three disconnected one-service traces instead of one end-to-end request. The
E2E test asserts the exact link: the users-service SERVER span's parent is the
gateway's CLIENT span.

---

## 3. Ingestion path

`POST /v1/traces` with `Content-Type: application/json` (optionally
`Content-Encoding: gzip`/`deflate`).

**Protocol scope (honest version):** TraceFlow implements the OTLP/HTTP
**JSON** encoding of `ExportTraceServiceRequest` for **traces**. OTLP/HTTP
protobuf returns `415` with a message telling you to set
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`; OTLP/gRPC, metrics and logs are not
implemented. The OpenTelemetry JS `exporter-trace-otlp-http` used by the demo
sends exactly this JSON encoding, and a payload captured from it is a unit-test
fixture (`apps/collector/test/fixtures/otel-js-export.json`).

**Parsing is lenient about representation, strict about meaning**
(`apps/collector/src/otlp/parse.ts`):

| Input variation                                             | Handling                                           |
| ----------------------------------------------------------- | -------------------------------------------------- |
| ids as hex (OTLP/JSON spec) or base64 (generic proto3 JSON) | normalized to lowercase hex; all-zero ids rejected |
| uint64 as string, number or `{low, high}`                   | parsed to `BigInt`, never through a lossy float    |
| enums as ints or names (`SPAN_KIND_CLIENT`)                 | mapped to OTLP numbers                             |
| camelCase or snake_case fields                              | both accepted                                      |
| int64 attribute > 2^53                                      | kept as exact decimal string                       |
| NaN/Infinity doubles                                        | kept as strings (JSON can't hold them)             |
| U+0000 in strings                                           | stripped (PostgreSQL text/jsonb reject NUL)        |
| `__proto__`/`constructor` keys                              | dropped                                            |

**Validation is per span.** A span with an invalid id, empty name, or end before
start is rejected with a reason; the other spans in the request are stored.
The response follows OTLP's `partialSuccess` contract
(`{ partialSuccess: { rejectedSpans, errorMessage } }`), so SDKs log the
problem instead of retrying a batch that can never succeed.

**Limits:** 8 MiB body (measured _after_ decompression, which also defuses gzip
bombs), 10,000 spans/request, 128 attributes/events per span, 32 links,
4 KiB per string value. Truncation is visible (`…[truncated N chars]`).

**Error classification** is decided once, at ingest, and stored as
`spans.is_error`: a span is an error iff its status is `ERROR`, or its status
is `UNSET` and it carries an `exception` event with `exception.escaped=true`.
An explicit `OK` always wins. Following HTTP semantic conventions, a 4xx on a
SERVER span is not an error (the server behaved correctly) whereas the caller's
CLIENT span records it as one.

---

## 4. Data model

```
services (id, name, environment, created_at, last_seen_at)       UNIQUE(name, environment)

traces   (trace_id PK, root_service_id → services, root_service, root_operation,
          root_span_id, has_root, start_time, end_time, start_unix_nano,
          end_unix_nano, duration_ms, status, span_count, error_count,
          orphan_count, services text[], created_at, updated_at)

spans    (trace_id, span_id) PK, parent_span_id, service_id → services,
          operation_name, kind, start_time, start_unix_nano, end_unix_nano,
          duration_ms, status_code, status_message, is_error,
          attributes jsonb, resource_attributes jsonb, events jsonb,
          links jsonb, scope_name, ingested_at
```

Design notes:

- **Identifier semantics.** `trace_id char(32)` / `span_id char(16)` hold
  canonical lowercase hex, byte-for-byte what appears in `traceparent`, so an
  id copied from a log or a response header (`x-trace-id`) can be pasted into
  the search box.
- **Span identity is `(trace_id, span_id)`.** Span ids are only required to be
  unique within a trace; the composite key is also the idempotency key.
- **Exact time.** `start_unix_nano`/`end_unix_nano` are `bigint` and are the
  source of truth; `timestamptz` columns (microsecond precision) exist for
  range predicates and indexes. The API computes per-span offsets from the
  exact integers and only then converts to floating-point milliseconds, so
  sub-millisecond spans render at the right position.
- **`traces` is a derived table.** It is a cache of facts computable from
  `spans`, maintained by the collector so list views never aggregate spans.
- **Denormalised `services text[]`** on traces with a GIN index answers "traces
  that touched service X" (`services @> array[$1]`) without a join.
- **Resource attributes are stored per span** (JSONB). That duplicates data
  across spans of one process; it keeps writes simple and is listed under
  future work (a `resources` table keyed by hash).

Indexes (all in `packages/db/drizzle/0000_init.sql`):

| Index                                                    | Serves                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `traces(start_time desc)`                                | default trace list, time windows, overview                   |
| `traces(root_service, start_time desc)`                  | per-root-service listing                                     |
| `traces(duration_ms desc)`                               | "slowest first" sort, duration filters                       |
| `traces(start_time desc) where status='error'` (partial) | error-only views stay fast when errors are rare              |
| `traces using gin(services)`                             | service filter                                               |
| `spans(service_id, start_time desc)`                     | per-service metrics and operations                           |
| `spans(start_time desc)`                                 | windowed aggregations                                        |
| `spans(trace_id, parent_span_id)`                        | parent/child self-join for dependencies and orphan detection |

---

## 5. Trace summaries under out-of-order, duplicate and concurrent arrival

This is the most interesting correctness problem in the system.

**Out-of-order arrival is the normal case.** A child span ends before its
parent, so its process exports it first; three processes flush their batch
processors independently; network retries reorder things further. The demo
trace's database span routinely arrives before the gateway's root span. The
root can also never arrive (sampled out, crashed process, uninstrumented hop).

**Approach: recompute, don't accumulate.** After inserting a batch, the
collector recomputes the summary of every affected trace from _all_ stored
spans of that trace, in the same transaction
(`recomputeTraceSummaries` in `apps/collector/src/ingest.ts`):

- `start/end` = min start / max end over all spans (children may outlive the root);
- `span_count`, `error_count`, `services` = aggregates;
- `orphan_count` = spans whose `parent_span_id` is not stored;
- **root** = the span with no parent if present; otherwise the earliest orphan
  stands in so the list still shows a meaningful name, and `has_root = false`
  marks the trace as incomplete in the UI.

Because the summary is a pure function of the _set_ of stored spans, any
arrival order converges to the same row. The integration suite ingests the
same three batches in three different orders and asserts identical summaries.

The cost is O(spans in trace) per batch touching it. For typical traces
(tens to hundreds of spans) that is negligible; for very large traces an
incremental merge (min/max/count are associative) would be the optimisation,
with orphan resolution done lazily.

**Duplicates.** OTLP exporters retry whole batches on timeouts and 5xx, so a
span may arrive more than once. `INSERT … ON CONFLICT (trace_id, span_id) DO
NOTHING` makes re-delivery a no-op; duplicates inside one request are removed
before the insert. First write wins — spans are immutable once ended, so
retries carry identical content.

**Concurrency.** Two requests carrying spans of the same trace can commit
concurrently. Under READ COMMITTED, transaction B's recompute might not see
A's uncommitted spans and could overwrite A's newer summary with a stale one.
Each transaction therefore takes `pg_advisory_xact_lock(hashtextextended(trace_id))`
for every trace in its batch _before_ inserting, in sorted hash order (a
global lock order, so two batches can never deadlock). Same-trace work is
serialised; different traces never contend; locks release at commit. Hash
collisions only cause harmless extra serialisation. The integration test fires
nine concurrent requests for one trace and asserts the final counts.

**Partial traces** are first-class: the waterfall attaches spans whose parent is
missing at the top level with a "parent missing" marker, the trace header shows
"Incomplete trace", and summaries heal automatically when the missing spans
arrive.

---

## 6. Query path and analytics

All analytics are SQL over the stored telemetry — nothing is pre-generated or
synthetic.

- **Trace search** builds a parameterised `WHERE` from validated filters (zod).
  User input only ever appears as bound parameters; the sort column comes from
  a whitelist. Text search treats a 4–32 char hex string as a trace-id prefix,
  otherwise matches root operation/service (`ILIKE` with LIKE metacharacters
  escaped). Pagination is limit/offset with a total count.
- **Percentiles** use `percentile_cont(p) WITHIN GROUP (ORDER BY duration_ms)`,
  i.e. linear interpolation between closest ranks. `@traceflow/shared` has the
  identical definition (`rank = p·(n−1)`), and an integration test asserts the
  API's p50/p95/p99 equal the TypeScript implementation on the same data.
  These are _exact_ percentiles over raw rows — fine at MVP scale; at volume
  you'd switch to mergeable sketches (t-digest / DDSketch / HDR histograms).
- **Request / latency per service** are computed over **entry spans**: kind
  SERVER or CONSUMER, or root spans. This measures what callers experienced.
- **Time series** use `generate_series` over `date_bin` buckets aligned to the
  epoch, so empty buckets render as zero and buckets don't shift between
  refreshes.
- **Service dependencies** are derived from links that were actually observed:
  1. _service → service_: a span whose parent span belongs to a different
     service (in practice the callee's SERVER span under the caller's CLIENT
     span) — `spans c JOIN spans p ON p.trace_id = c.trace_id AND p.span_id =
c.parent_span_id WHERE c.service <> p.service`;
  2. _service → database/broker_: CLIENT/PRODUCER spans carrying
     `db.system(.name)` or `messaging.system`. The database doesn't emit spans,
     so this edge is inferred from the caller's attributes and drawn as a
     distinct node kind with that label.

  Edges are computed at query time rather than maintained at ingest because the
  join is order-independent: an edge appears as soon as both ends are stored.
  An orphan span contributes no edge — the test suite checks that no edge is
  invented for it.

---

## 7. Live updates

```
collector txn ──pg_notify('traceflow_ingest', {traceIds})──▶ (delivered on COMMIT only)
API LiveHub  ──LISTEN──▶ coalesce 250 ms ──▶ load summaries once ──▶ fan-out
browser      ◀── SSE: event: traces {traces:[…]} ── /api/stream
```

- **Transactional notifications.** NOTIFY inside the ingest transaction is
  delivered only if it commits, so the UI is never told about rows it can't
  read. Payloads (8 KB limit) carry at most 150 ids; overflow becomes a
  `resync` event.
- **Coalescing.** Bursts of notifications are merged for 250 ms and summaries
  are fetched once per burst, so N clients × M batches doesn't become N×M
  queries.
- **SSE over WebSockets.** Updates are one-directional; SSE works through the
  Vite proxy, reconnects natively, and needs no extra library.
- **Reconnection & missed events.** postgres.js re-establishes LISTEN after
  database restarts; the hub then emits `resync`. In the browser, EventSource
  reconnects on network errors; if the server answered with an error status it
  gives up, so `LiveProvider` reconnects manually with capped exponential
  backoff. Every (re)connect invalidates cached queries because anything sent
  while disconnected was lost.
- **Duplicates.** A trace is announced several times as its spans arrive from
  different services. The client keeps a bounded (50) feed keyed by trace id —
  the newest summary replaces the old one — and refetches aggregate views at
  most every 1.5 s.
- **Leaks.** Server: each connection unsubscribes on `close`, heartbeats every
  15 s, a 100-client cap, and slow consumers whose socket buffer passes 1 MiB
  are dropped instead of buffered forever. Client: the EventSource and all
  timers are closed on unmount; the integration test asserts the subscriber
  count returns to zero after disconnect.

---

## 8. The waterfall

`apps/web/src/features/waterfall/` with algorithms in `packages/shared/src/trace-tree.ts`:

- **Tree reconstruction** (`buildTraceTree`) indexes spans by id and attaches
  each to its parent. Missing parent → orphan root (flagged). Self-parenting
  or cycles (malformed input) are detected by a reachability pass and broken
  instead of looping or silently dropping spans. Children are ordered by start
  time. Everything is iterative, so a 20,000-deep chain can't overflow the
  stack (unit-tested).
- **Positioning** uses server-computed `offsetMs` (exact BigInt math) and
  `durationMs`: `left = (offset − viewStart) / viewSpan`,
  `width = duration / viewSpan`, clamped to the view. The trace extent is the
  max span end, not the root's end, because async children can outlive it.
- **Self time** = duration − union of children intervals clipped to the parent
  (overlapping concurrent children counted once). Summed per service it gives
  the "Time by service" bar — where the request actually spent its time
  without double counting nesting.
- **Critical path** walks backwards from each span's end, repeatedly choosing
  the child that finished last before the cursor (Jaeger's approach). In the
  checkout trace the concurrent user lookup is correctly _off_ the critical
  path because the parallel inventory lookup took longer.
- **Performance.** Rows are virtualised (`@tanstack/react-virtual`): a
  5,000-span trace renders only the visible rows; the minimap draws to a `<canvas>`;
  rows are memoised. The E2E suite loads a 5,000-span trace and asserts the
  DOM stays under 150 rows.
- **Zoom** by dragging on the minimap or "Zoom timeline to span"; ticks use a
  1/2/5×10^k step.
- **Accessibility.** The list is an ARIA tree (arrow keys move/expand/collapse,
  Esc closes the inspector). Status is never conveyed by colour alone: error
  spans get an icon, red text, a ring and a hatch pattern.

---

## 9. Failure handling

| Failure                            | Behaviour                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed JSON / invalid structure | `400` + OTLP `Status` body (`{code: 3, message}`)                                                                                                    |
| Some invalid spans                 | `200` + `partialSuccess`; valid spans stored                                                                                                         |
| Protobuf / unknown encoding        | `415` with an actionable message                                                                                                                     |
| Body over limit (after gunzip)     | `413`                                                                                                                                                |
| Database unreachable during ingest | `503` + `Retry-After: 5` — a _retryable_ response in the OTLP spec, so SDKs keep the batch and retry with backoff instead of dropping it             |
| Database down while browsing       | API `503 storage_unavailable`; UI shows an explicit "API unavailable" state and TanStack Query retries with backoff; health indicator in the sidebar |
| API restarts                       | SSE reconnects; queries are invalidated on reconnect                                                                                                 |
| Exporter retries a batch           | idempotent insert, reported as duplicates                                                                                                            |

Neither server buffers spans in memory while the database is down: durability
is delegated to the exporter's retry queue. A production collector would add a
bounded on-disk queue (or sit behind the OpenTelemetry Collector).

---

## 10. Security posture

Implemented:

- All servers bind to `127.0.0.1` by default; Postgres is published only on
  `127.0.0.1:5544`.
- CORS on the API and collector is an explicit allow-list (default: the
  dashboard origin); the dashboard itself is same-origin.
- All SQL is parameterised (postgres.js tagged templates); the only spliced
  fragments are server-owned constants or whitelisted identifiers.
- Every query parameter is validated with zod; errors return a structured 400.
- Telemetry is untrusted input: size limits, NUL stripping,
  prototype-pollution keys dropped; in the browser attribute values are only
  rendered as React text nodes (escaped), never as HTML.
- Logs never include request bodies; auth/cookie headers are redacted;
  database URLs are logged with the password masked.
- The demo services disable host/process resource detection so hostnames,
  user paths and command lines are never attached to spans.

Public demo mode (see [DEPLOYMENT.md](DEPLOYMENT.md)) adds per-visitor and site-wide rate
limits, a live-connection cap, query timeouts, a read-only database session for the API, a
strict content security policy and trace retention. The collector is never exposed.

Out of scope for the MVP (documented, not claimed): authentication and
authorisation, multi-tenant isolation, TLS, per-tenant rate limiting, PII scrubbing rules.

---

## 11. Testing strategy

| Layer                                | What it proves                                                                                                                                                                                                                                                                                                                                                                                  | Where                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Unit (Vitest)                        | OTLP parsing on a payload captured from the real OTel JS exporter; id/uint64/enum normalisation; attribute limits and sanitisation; error classification; percentiles; tree reconstruction (orphans, cycles, deep chains); self time; critical path                                                                                                                                             | `packages/shared/test`, `apps/collector/test/unit` |
| Integration (Vitest + real Postgres) | persistence; idempotent duplicates; order-independent summaries; 9-way concurrent ingest of one trace; partial success; gzip and gzip-bomb limits; 503 + Retry-After with the DB down; search filters/sort/pagination; percentile parity SQL ↔ TS; dependency derivation (and no invented edges); service metrics/histograms; SSE push and subscriber cleanup; CORS; OpenAPI covers every route | `apps/*/test/integration`                          |
| End-to-end (Playwright)              | the full stack on isolated ports: real instrumented services → collector → Postgres → API → browser; live arrival over SSE; cross-service parent links in the waterfall; slow span on the critical path; error indicators and exception events; explorer filters; service-map edges; 5,000-span trace stays virtualised                                                                         | `e2e/`                                             |

---

## 12. Trade-offs and what I'd do next

| Decision                    | Why                                                           | Cost / next step                                                                                      |
| --------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| PostgreSQL for spans        | one dependency, transactions, rich SQL, LISTEN/NOTIFY         | row store; at scale move spans to ClickHouse or Parquet on object storage, keep Postgres for metadata |
| Recompute summary per batch | trivially order-independent                                   | O(trace size) per batch; switch to associative incremental merge                                      |
| Query-time dependency join  | order-independent, no extra state                             | cost grows with window; materialise edges per minute bucket                                           |
| Exact percentiles           | correct and simple                                            | O(n log n) per query; use DDSketch/t-digest rollups                                                   |
| JSON-only OTLP              | covers the OTel JS default exporter, testable without codegen | add protobuf (`@opentelemetry/otlp-transformer` + protobufjs) and gRPC                                |
| Limit/offset pagination     | simple, supports "page N of M"                                | keyset pagination on `(start_time, trace_id)` for deep pages                                          |
| No in-collector buffer      | exporters already retry on 503                                | bounded disk queue for long outages                                                                   |
| Resource attrs per span     | simple writes                                                 | dedupe into a `resources` table keyed by hash                                                         |

Further: tail-based sampling, span search by attribute (`attributes @>` with a
GIN index), trace comparison, retention jobs, auth, metrics/logs correlation,
and a light theme.
