import { useQuery } from '@tanstack/react-query';
import {
  WINDOW_LABELS,
  formatDuration,
  formatPercent,
  formatRate,
  type DependencyEdge,
} from '@traceflow/shared';
import { ArrowLeft, ArrowRight, Database } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { HistogramChart, LatencyChart, VolumeChart } from '@/components/charts/charts';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  ServiceChip,
  ServiceDot,
  StatTile,
  WindowSelect,
} from '@/components/common';
import { TraceTable } from '@/components/trace-table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useLive } from '@/hooks/use-live';
import { useTimeWindow } from '@/hooks/use-time-window';
import { ApiRequestError, api, queryKeys } from '@/lib/api';
import { formatBucket } from './overview';

function DependencyList({
  edges,
  direction,
}: {
  edges: DependencyEdge[];
  direction: 'upstream' | 'downstream';
}) {
  if (edges.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-ink-3">
        {direction === 'upstream'
          ? 'No callers observed (entry point).'
          : 'No outgoing calls observed.'}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line/70">
      {edges.map((e) => {
        const peer = direction === 'upstream' ? e.source : e.target;
        const external = direction === 'downstream' && e.targetKind !== 'service';
        return (
          <li
            key={`${e.source}-${e.target}`}
            className="flex items-center justify-between gap-3 px-4 py-2 text-xs"
          >
            {external ? (
              <span className="flex items-center gap-1.5 text-ink-2">
                <Database className="size-3.5 text-ink-3" aria-hidden />
                {peer.replace(':', ' · ')}
              </span>
            ) : (
              <ServiceChip name={peer} link className="text-ink" />
            )}
            <span className="num flex items-center gap-3 text-ink-3">
              <span>{e.callCount} calls</span>
              <span className={e.errorCount ? 'text-[#ff8a8d]' : ''}>{e.errorCount} err</span>
              <span className="text-ink-2">p95 {formatDuration(e.latency.p95)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ServiceDetailPage() {
  const { name = '' } = useParams();
  const [window, setWindow] = useTimeWindow();
  const { freshIds } = useLive();
  const detail = useQuery({
    queryKey: queryKeys.service(name, window),
    queryFn: ({ signal }) => api.service(name, window, signal),
  });
  const d = detail.data;
  const s = d?.service;

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link
              to="/services"
              aria-label="Back to services"
              className="text-ink-3 hover:text-ink"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <ServiceDot name={name} className="size-2.5" />
            {name}
            {s?.environment && <Badge>{s.environment}</Badge>}
          </span>
        }
        subtitle={`Computed from recorded spans · ${WINDOW_LABELS[window].toLowerCase()}`}
        actions={<WindowSelect value={window} onChange={setWindow} />}
      />
      <div className="space-y-4 p-5">
        {detail.isError ? (
          <Panel>
            {detail.error instanceof ApiRequestError && detail.error.status === 404 ? (
              <EmptyState title="No telemetry for this service in the selected window">
                Try a longer time window.
              </EmptyState>
            ) : (
              <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
            )}
          </Panel>
        ) : (
          <>
            <Panel bodyClassName="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              {!s ? (
                Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="px-4 py-3">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="mt-2 h-6 w-20" />
                  </div>
                ))
              ) : (
                <>
                  <StatTile
                    label="Requests"
                    value={s.requestCount.toLocaleString()}
                    hint="entry spans"
                  />
                  <StatTile label="Rate" value={formatRate(s.requestRate)} />
                  <StatTile
                    label="Error rate"
                    value={formatPercent(s.errorRate)}
                    hint={`${s.errorCount} failed`}
                    tone={s.errorCount ? 'error' : 'default'}
                  />
                  <StatTile label="P50" value={formatDuration(s.latency.p50)} />
                  <StatTile label="P95" value={formatDuration(s.latency.p95)} />
                  <StatTile label="P99" value={formatDuration(s.latency.p99)} />
                </>
              )}
            </Panel>

            <div className="grid gap-4 xl:grid-cols-3">
              <Panel
                title="Request volume"
                description={d ? `Requests per ${formatBucket(d.bucketSeconds)}` : undefined}
                bodyClassName="p-4"
              >
                {d ? (
                  <VolumeChart data={d.timeseries} bucketSeconds={d.bucketSeconds} />
                ) : (
                  <Skeleton className="h-40" />
                )}
              </Panel>
              <Panel
                title="P95 latency"
                description="Entry-span duration over time"
                bodyClassName="p-4"
              >
                {d ? (
                  <LatencyChart data={d.timeseries} bucketSeconds={d.bucketSeconds} />
                ) : (
                  <Skeleton className="h-40" />
                )}
              </Panel>
              <Panel
                title="Latency distribution"
                description="Entry spans by duration bucket"
                bodyClassName="p-4"
              >
                {d ? <HistogramChart data={d.histogram} /> : <Skeleton className="h-40" />}
              </Panel>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Panel
                title="Operations"
                description="All spans this service emitted, grouped by name and kind"
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-xs">
                    <thead>
                      <tr className="border-b border-line text-[11px] text-ink-3 [&>th]:h-8 [&>th]:px-3 [&>th]:font-medium">
                        <th className="!pl-4">Operation</th>
                        <th>Kind</th>
                        <th className="text-right">Count</th>
                        <th className="text-right">Errors</th>
                        <th className="text-right">P50</th>
                        <th className="text-right">P95</th>
                        <th className="!pr-4 text-right">P99</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d?.operations.map((o) => (
                        <tr
                          key={`${o.name}-${o.kind}`}
                          className="border-b border-line/70 last:border-0 [&>td]:px-3 [&>td]:py-2"
                        >
                          <td
                            className="max-w-[280px] truncate !pl-4 font-medium text-ink"
                            title={o.name}
                          >
                            <Link
                              className="hover:underline"
                              to={`/traces?service=${encodeURIComponent(name)}&q=${encodeURIComponent(o.name)}`}
                            >
                              {o.name}
                            </Link>
                          </td>
                          <td className="text-ink-3">{o.kind}</td>
                          <td className="num text-right text-ink">{o.count}</td>
                          <td
                            className={`num text-right ${o.errorCount ? 'text-[#ff8a8d]' : 'text-ink-3'}`}
                          >
                            {o.errorCount}
                          </td>
                          <td className="num text-right text-ink-2">
                            {formatDuration(o.latency.p50)}
                          </td>
                          <td className="num text-right text-ink">
                            {formatDuration(o.latency.p95)}
                          </td>
                          <td className="num !pr-4 text-right text-ink-2">
                            {formatDuration(o.latency.p99)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <div className="space-y-4">
                <Panel
                  title={
                    <span className="flex items-center gap-1.5">
                      <ArrowRight className="size-3 rotate-180" /> Upstream callers
                    </span>
                  }
                >
                  {d ? (
                    <DependencyList edges={d.upstream} direction="upstream" />
                  ) : (
                    <Skeleton className="m-4 h-8" />
                  )}
                </Panel>
                <Panel
                  title={
                    <span className="flex items-center gap-1.5">
                      <ArrowRight className="size-3" /> Downstream dependencies
                    </span>
                  }
                >
                  {d ? (
                    <DependencyList edges={d.downstream} direction="downstream" />
                  ) : (
                    <Skeleton className="m-4 h-8" />
                  )}
                </Panel>
              </div>
            </div>

            <Panel
              title="Recent traces"
              description={`Traces that include ${name}`}
              actions={
                <Link
                  to={`/traces?service=${encodeURIComponent(name)}`}
                  className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink"
                >
                  All traces <ArrowRight className="size-3" />
                </Link>
              }
            >
              <TraceTable traces={d?.recentTraces ?? []} loading={!d} fresh={freshIds} compact />
            </Panel>
          </>
        )}
      </div>
    </>
  );
}
