import { useQuery } from '@tanstack/react-query';
import {
  buildTraceTree,
  formatDuration,
  selfTimeBreakdown,
  type TraceDetail,
} from '@traceflow/shared';
import { ArrowLeft, CircleDashed, Info } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CopyButton, EmptyState, ErrorState, ServiceChip, StatusBadge } from '@/components/common';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { Waterfall } from '@/features/waterfall/waterfall';
import { ApiRequestError, api, queryKeys } from '@/lib/api';
import { serviceColor } from '@/lib/colors';
import { formatDateTime } from '@/lib/utils';

function TimeByService({ detail }: { detail: TraceDetail }) {
  const breakdown = useMemo(() => {
    const tree = buildTraceTree(detail.spans);
    return selfTimeBreakdown(tree, (s) => s.service);
  }, [detail.spans]);
  const total = breakdown.reduce((sum, b) => sum + b.selfMs, 0);
  if (total <= 0) return null;
  return (
    <div className="min-w-0 flex-1 basis-80">
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">
        Time by service
        <Tooltip content="Self time: each span's duration minus the time covered by its children, summed per service. Shows where the request actually spent its time.">
          <Info className="size-3 cursor-help" aria-label="About self time" />
        </Tooltip>
      </div>
      <div className="flex h-2 gap-[2px] overflow-hidden rounded-full" aria-hidden>
        {breakdown.map((b) => (
          <div
            key={b.key}
            style={{ width: `${(b.selfMs / total) * 100}%`, backgroundColor: serviceColor(b.key) }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {breakdown.map((b) => (
          <li key={b.key} className="flex items-center gap-1.5 text-ink-2">
            <ServiceChip name={b.key} link />
            <span className="num text-ink">{formatDuration(b.selfMs)}</span>
            <span className="num text-ink-3">{((b.selfMs / total) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TraceDetailPage() {
  const { traceId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('span');
  const trace = useQuery({
    queryKey: queryKeys.trace(traceId),
    queryFn: ({ signal }) => api.trace(traceId, signal),
    // Spans of a fresh trace may still be arriving; SSE invalidates this query too.
    refetchInterval: (q) =>
      q.state.data && Date.now() - new Date(q.state.data.trace.updatedAt).getTime() < 15_000
        ? 3_000
        : false,
  });

  const select = (spanId: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (spanId) next.set('span', spanId);
        else next.delete('span');
        return next;
      },
      { replace: true },
    );

  const d = trace.data;
  const t = d?.trace;
  const depth = useMemo(() => (d ? buildTraceTree(d.spans).maxDepth + 1 : 0), [d]);

  return (
    <div className="flex min-h-[640px] flex-1 flex-col">
      <header className="border-b border-line px-5 py-3">
        <Link
          to="/traces"
          className="mb-2 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"
        >
          <ArrowLeft className="size-3" /> Traces
        </Link>
        {!t ? (
          trace.isError ? null : (
            <div className="space-y-2">
              <Skeleton className="h-5 w-72" />
              <Skeleton className="h-3 w-96" />
            </div>
          )
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1
                  className="truncate text-[15px] font-semibold tracking-tight"
                  data-testid="trace-title"
                >
                  {t.rootOperation ?? '(unknown root)'}
                </h1>
                <StatusBadge status={t.status} count={t.errorCount} />
                {!t.hasRoot && (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-warn/35 bg-warn/10 px-1.5 text-[11px] text-[#f7c46b]">
                    <CircleDashed className="size-3" aria-hidden /> Incomplete trace
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
                <span className="flex items-center gap-1 font-mono text-ink-2">
                  {t.traceId}
                  <CopyButton value={t.traceId} label="Copy trace ID" />
                </span>
                <span className="num">{formatDateTime(t.startTime)}</span>
              </div>
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
                {[
                  ['Duration', formatDuration(t.durationMs)],
                  ['Spans', String(t.spanCount)],
                  ['Services', String(t.services.length)],
                  ['Depth', String(depth)],
                  ['Errors', String(t.errorCount)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[10px] uppercase tracking-wide text-ink-3">{label}</dt>
                    <dd
                      className="num text-sm font-semibold text-ink"
                      data-testid={`trace-${label!.toLowerCase()}`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
            {d && <TimeByService detail={d} />}
          </div>
        )}
        {t && (t.orphanCount > 0 || d?.truncated) && (
          <p
            role="note"
            className="mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-1.5 text-xs text-[#f7c46b]"
          >
            {d?.truncated && 'This trace exceeds 10,000 spans; only the first 10,000 are shown. '}
            {t.orphanCount > 0 &&
              `${t.orphanCount} span${t.orphanCount === 1 ? ' references a parent' : 's reference parents'} that ha${t.orphanCount === 1 ? 's' : 've'} not been received — shown at the top level and marked “parent missing”.`}
          </p>
        )}
      </header>

      {trace.isError ? (
        trace.error instanceof ApiRequestError && trace.error.status === 404 ? (
          <EmptyState title="Trace not found">
            No spans with trace id <span className="font-mono">{traceId}</span> have been ingested.
            Spans can take a moment to arrive.
          </EmptyState>
        ) : (
          <ErrorState error={trace.error} onRetry={() => void trace.refetch()} />
        )
      ) : !d ? (
        <div className="space-y-1.5 p-4">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-6" />
          ))}
        </div>
      ) : (
        <Waterfall
          spans={d.spans}
          totalMs={d.trace.durationMs}
          selectedId={selectedId}
          onSelect={select}
        />
      )}
    </div>
  );
}
