/**
 * Live updates over Server-Sent Events.
 *
 * - One EventSource per tab, owned by <LiveProvider>; closed on unmount.
 * - `traces` events are merged into a bounded, de-duplicated feed (a trace
 *   can be announced several times as its spans arrive from different
 *   services — the newest summary wins) and trigger throttled refetches.
 * - EventSource reconnects by itself after network errors, but gives up for
 *   good on an HTTP error status; we then reconnect manually with backoff.
 * - After any reconnect (or a `resync` event) all queries are invalidated,
 *   because notifications sent while disconnected were missed.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { LiveTracesEvent, TraceSummary } from '@traceflow/shared';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'paused';

interface LiveContextValue {
  status: LiveStatus;
  /** Most recent traces announced by the stream, newest first (max 50). */
  feed: TraceSummary[];
  /** Trace ids that arrived in the last few seconds (for highlight effects). */
  freshIds: ReadonlySet<string>;
  paused: boolean;
  setPaused: (paused: boolean) => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);
const FEED_LIMIT = 50;
const REFETCH_THROTTLE_MS = 1500;

export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [feed, setFeed] = useState<TraceSummary[]>([]);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (paused) {
      setStatus('paused');
      return;
    }
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;
    let freshTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let disposed = false;
    let hadError = false;

    const scheduleRefetch = () => {
      if (refetchTimer) return;
      refetchTimer = setTimeout(() => {
        refetchTimer = undefined;
        // Only aggregate views; an open trace is invalidated precisely below.
        void queryClient.invalidateQueries({
          predicate: (q) =>
            ['overview', 'traces', 'services', 'service', 'dependencies'].includes(
              String(q.queryKey[0]),
            ),
        });
      }, REFETCH_THROTTLE_MS);
    };

    const connect = () => {
      setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
      source = new EventSource('/api/stream');

      source.addEventListener('ready', () => {
        if (hadError || attempts > 0) void queryClient.invalidateQueries();
        attempts = 0;
        hadError = false;
        setStatus('live');
      });

      source.addEventListener('traces', (event) => {
        const { traces } = JSON.parse((event as MessageEvent<string>).data) as LiveTracesEvent;
        setFeed((current) => {
          const byId = new Map(current.map((t) => [t.traceId, t]));
          for (const t of traces) byId.set(t.traceId, t);
          return [...byId.values()]
            .sort((a, b) => b.startTime.localeCompare(a.startTime))
            .slice(0, FEED_LIMIT);
        });
        setFreshIds((current) => new Set([...current, ...traces.map((t) => t.traceId)]));
        clearTimeout(freshTimer);
        freshTimer = setTimeout(() => setFreshIds(new Set()), 2500);
        for (const t of traces)
          void queryClient.invalidateQueries({ queryKey: ['trace', t.traceId] });
        scheduleRefetch();
      });

      source.addEventListener('resync', () => void queryClient.invalidateQueries());

      source.onerror = () => {
        hadError = true;
        setStatus('reconnecting');
        if (source?.readyState === EventSource.CLOSED && !disposed) {
          // The browser gave up (e.g. HTTP 503); retry with capped exponential backoff.
          source.close();
          const delay = Math.min(30_000, 1000 * 2 ** attempts++);
          retryTimer = setTimeout(connect, delay);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      clearTimeout(retryTimer);
      clearTimeout(refetchTimer);
      clearTimeout(freshTimer);
    };
  }, [paused, queryClient]);

  const value = useMemo(
    () => ({ status, feed, freshIds, paused, setPaused }),
    [status, feed, freshIds, paused],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error('useLive must be used inside <LiveProvider>');
  return ctx;
}
