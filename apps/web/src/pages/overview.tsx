import { useQuery } from '@tanstack/react-query';
import { WINDOW_LABELS, formatDuration, formatPercent, formatRate } from '@traceflow/shared';
import { ArrowRight, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { LatencyChart, VolumeChart } from '@/components/charts/charts';
import {
  EmptyState,
  ErrorState,
  InlineBar,
  PageHeader,
  Panel,
  ServiceChip,
  StatTile,
  WindowSelect,
} from '@/components/common';
import { useDemo } from '@/components/demo-notice';
import { TraceTable } from '@/components/trace-table';
import { Skeleton } from '@/components/ui/skeleton';
import { useLive } from '@/hooks/use-live';
import { useTimeWindow } from '@/hooks/use-time-window';
import { api, queryKeys } from '@/lib/api';
import { serviceColor } from '@/lib/colors';
import { formatCount } from '@/lib/utils';

export function GettingStarted() {
  const demo = useDemo();
  if (demo) {
    return (
      <EmptyState title="Waiting for the next demo request">
        The demo services handle a request every few seconds; traces appear here automatically.
      </EmptyState>
    );
  }
  return (
    <EmptyState title="No traces in this window yet" icon={<Terminal className="size-4" />}>
      <p>Start the instrumented demo services and send some requests:</p>
      <pre className="mt-3 rounded-md border border-line bg-canvas px-3 py-2 text-left font-mono text-[11px] text-ink-2">
        {
          'pnpm demo:services   # gateway, users, inventory\npnpm demo            # scenarios A, B, C'
        }
      </pre>
    </EmptyState>
  );
}

export function OverviewPage() {
  const [window, setWindow] = useTimeWindow();
  const { freshIds } = useLive();
  const overview = useQuery({
    queryKey: queryKeys.overview(window),
    queryFn: ({ signal }) => api.overview(window, signal),
    refetchInterval: 30_000,
  });
  const o = overview.data;
  const windowLabel = WINDOW_LABELS[window].toLowerCase();

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`All figures computed from stored spans · ${windowLabel}`}
        actions={<WindowSelect value={window} onChange={setWindow} />}
      />
      <div className="space-y-4 p-5">
        {overview.isError && !o ? (
          <Panel>
            <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
          </Panel>
        ) : (
          <>
            <Panel bodyClassName="flex flex-wrap overflow-hidden rounded-lg [&>*]:-mr-px [&>*]:-mb-px [&>*]:basis-1/2 [&>*]:border-r [&>*]:border-b [&>*]:border-line sm:[&>*]:basis-1/4 xl:[&>*]:basis-[calc(100%/7)]">
              {!o ? (
                Array.from({ length: 7 }, (_, i) => (
                  <div key={i} className="px-4 py-3">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="mt-2 h-6 w-20" />
                  </div>
                ))
              ) : (
                <>
                  <StatTile
                    label="Traces"
                    value={formatCount(o.traceCount)}
                    hint={`${formatCount(o.spanCount)} spans`}
                  />
                  <StatTile
                    label="Request rate"
                    value={formatRate(o.requestRate)}
                    hint="traces, window average"
                  />
                  <StatTile
                    label="Error rate"
                    value={formatPercent(o.errorRate)}
                    hint={`${o.errorTraceCount} failed trace${o.errorTraceCount === 1 ? '' : 's'}`}
                    tone={o.errorTraceCount > 0 ? 'error' : 'default'}
                  />
                  <StatTile
                    label="P50 latency"
                    value={formatDuration(o.latency.p50)}
                    hint="end-to-end trace"
                  />
                  <StatTile
                    label="P95 latency"
                    value={formatDuration(o.latency.p95)}
                    hint="end-to-end trace"
                  />
                  <StatTile
                    label="P99 latency"
                    value={formatDuration(o.latency.p99)}
                    hint="end-to-end trace"
                  />
                  <StatTile label="Services" value={o.serviceCount} hint="reporting spans" />
                </>
              )}
            </Panel>

            {o && o.traceCount === 0 ? (
              <Panel>
                <GettingStarted />
              </Panel>
            ) : (
              <>
                <div className="grid gap-4 lg:grid-cols-2">
                  <Panel
                    title="Request volume"
                    description={`Traces per ${o ? formatBucket(o.bucketSeconds) : '…'} · ${windowLabel}`}
                    bodyClassName="p-4"
                  >
                    {o ? (
                      <VolumeChart
                        data={o.timeseries}
                        bucketSeconds={o.bucketSeconds}
                        unit="traces"
                      />
                    ) : (
                      <Skeleton className="h-40" />
                    )}
                  </Panel>
                  <Panel
                    title="P95 latency"
                    description={`End-to-end trace duration per ${o ? formatBucket(o.bucketSeconds) : '…'}`}
                    bodyClassName="p-4"
                  >
                    {o ? (
                      <LatencyChart data={o.timeseries} bucketSeconds={o.bucketSeconds} />
                    ) : (
                      <Skeleton className="h-40" />
                    )}
                  </Panel>
                </div>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <Panel
                    title="Recent traces"
                    description="Updates live as spans are ingested"
                    actions={
                      <Link
                        to="/traces"
                        className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink"
                      >
                        Explore <ArrowRight className="size-3" />
                      </Link>
                    }
                  >
                    <TraceTable
                      traces={o?.recentTraces ?? []}
                      loading={!o}
                      fresh={freshIds}
                      compact
                    />
                  </Panel>
                  <Panel
                    title="Slowest services"
                    description="By p95 of entry-span (server) latency"
                  >
                    {!o ? (
                      <div className="space-y-3 p-4">
                        {Array.from({ length: 3 }, (_, i) => (
                          <Skeleton key={i} className="h-8" />
                        ))}
                      </div>
                    ) : o.slowestServices.length === 0 ? (
                      <EmptyState title="No service latency yet" />
                    ) : (
                      <ul className="divide-y divide-line/70">
                        {o.slowestServices.map((s) => (
                          <li key={s.name}>
                            <Link
                              to={`/services/${encodeURIComponent(s.name)}?window=${window}`}
                              className="block px-4 py-2.5 hover:bg-hover/60"
                            >
                              <div className="flex items-center justify-between gap-3 text-xs">
                                <ServiceChip name={s.name} className="text-ink" />
                                <span className="num shrink-0 text-ink">
                                  {formatDuration(s.latency.p95)}{' '}
                                  <span className="text-ink-3">p95</span>
                                </span>
                              </div>
                              <div className="mt-1.5 flex items-center gap-3">
                                <InlineBar
                                  value={s.latency.p95 ?? 0}
                                  max={o.slowestServices[0]?.latency.p95 ?? 0}
                                  color={serviceColor(s.name)}
                                />
                                <span className="num w-28 shrink-0 text-right text-[11px] text-ink-3">
                                  {s.requestCount} req · {formatPercent(s.errorRate)} err
                                </span>
                              </div>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Panel>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function formatBucket(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${seconds / 60} min`;
  return `${seconds / 3600}h`;
}
