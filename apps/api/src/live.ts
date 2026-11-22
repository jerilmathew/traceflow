/**
 * Fan-out of "new spans were ingested" notifications to SSE clients.
 *
 * The collector issues `pg_notify('traceflow_ingest', {traceIds})` inside its
 * ingest transaction. This hub holds one LISTEN connection (postgres.js
 * re-establishes it automatically after connection loss), coalesces bursts of
 * notifications for 250ms, loads the affected trace summaries once, and
 * pushes them to every subscriber. Using PostgreSQL as the message bus keeps
 * the stack free of Redis/Kafka while still being push-based.
 */
import type { Sql } from '@traceflow/db';
import type { TraceSummary } from '@traceflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getTraceSummaries } from './queries/traces';

export const NOTIFY_CHANNEL = 'traceflow_ingest';
const COALESCE_MS = 250;
const MAX_IDS_PER_FLUSH = 200;

export type LiveEvent =
  | { type: 'traces'; traces: TraceSummary[] }
  /** Emitted after (re)connecting to PostgreSQL: clients should refetch, since notifications may have been missed. */
  | { type: 'resync' };

type Listener = (event: LiveEvent) => void;

export class LiveHub {
  private listeners = new Set<Listener>();
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private unlisten: (() => Promise<void>) | undefined;
  private listenCount = 0;
  listening = false;

  constructor(
    private readonly sql: Sql,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start(): Promise<void> {
    const sub = await this.sql.listen(
      NOTIFY_CHANNEL,
      (payload) => this.onNotify(payload),
      () => {
        this.listening = true;
        // Every reconnect after the first one means we may have missed events.
        if (this.listenCount++ > 0) {
          this.log.info('LISTEN re-established; asking clients to resync');
          this.emit({ type: 'resync' });
        }
      },
    );
    this.unlisten = sub.unlisten;
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.listeners.clear();
    await this.unlisten?.().catch(() => {});
    this.listening = false;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  private onNotify(payload: string): void {
    try {
      const parsed = JSON.parse(payload) as { traceIds?: unknown; truncated?: boolean };
      if (parsed.truncated) {
        this.emit({ type: 'resync' });
        return;
      }
      if (Array.isArray(parsed.traceIds)) {
        for (const id of parsed.traceIds) if (typeof id === 'string') this.pending.add(id);
      }
    } catch {
      this.log.warn('ignoring malformed notification payload');
      return;
    }
    if (this.pending.size >= MAX_IDS_PER_FLUSH) {
      this.pending.clear();
      this.emit({ type: 'resync' });
      return;
    }
    this.timer ??= setTimeout(() => void this.flush(), COALESCE_MS);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const ids = [...this.pending];
    this.pending.clear();
    if (ids.length === 0 || this.listeners.size === 0) return;
    try {
      const traces = await getTraceSummaries(this.sql, ids);
      if (traces.length > 0) this.emit({ type: 'traces', traces });
    } catch (error) {
      this.log.warn({ err: error }, 'failed to load live trace summaries');
      this.emit({ type: 'resync' });
    }
  }

  private emit(event: LiveEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log.warn({ err: error }, 'live listener failed');
      }
    }
  }
}
