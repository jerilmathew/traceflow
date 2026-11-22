import { useQuery } from '@tanstack/react-query';
import { WINDOW_LABELS, formatDuration, formatPercent, formatRate } from '@traceflow/shared';
import { AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  EmptyState,
  ErrorState,
  InlineBar,
  PageHeader,
  Panel,
  ServiceChip,
  WindowSelect,
} from '@/components/common';
import { Skeleton } from '@/components/ui/skeleton';
import { useTimeWindow } from '@/hooks/use-time-window';
import { api, queryKeys } from '@/lib/api';
import { serviceColor } from '@/lib/colors';
import { relativeTime } from '@/lib/utils';

export function ServicesPage() {
  const [window, setWindow] = useTimeWindow();
  const navigate = useNavigate();
  const services = useQuery({
    queryKey: queryKeys.services(window),
    queryFn: ({ signal }) => api.services(window, signal),
  });
  const items = services.data?.items ?? [];
  const maxP95 = Math.max(0, ...items.map((s) => s.latency.p95 ?? 0));

  return (
    <>
      <PageHeader
        title="Services"
        subtitle={`Request metrics from entry spans (server / consumer / root) · ${WINDOW_LABELS[window].toLowerCase()}`}
        actions={<WindowSelect value={window} onChange={setWindow} />}
      />
      <div className="p-5">
        <Panel>
          {services.isError && !services.data ? (
            <ErrorState error={services.error} onRetry={() => void services.refetch()} />
          ) : services.data && items.length === 0 ? (
            <EmptyState title="No services reported spans in this window" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead>
                  <tr className="border-b border-line text-[11px] text-ink-3 [&>th]:h-8 [&>th]:px-3 [&>th]:font-medium">
                    <th className="!pl-4">Service</th>
                    <th className="text-right">Requests</th>
                    <th className="text-right">Rate</th>
                    <th className="text-right">Error rate</th>
                    <th className="text-right">P50</th>
                    <th className="w-56">P95</th>
                    <th className="text-right">P99</th>
                    <th className="!pr-4 text-right">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {!services.data
                    ? Array.from({ length: 4 }, (_, i) => (
                        <tr key={i}>
                          <td colSpan={8} className="px-4 py-2.5">
                            <Skeleton className="h-4" />
                          </td>
                        </tr>
                      ))
                    : items.map((s) => (
                        <tr
                          key={s.name}
                          className="cursor-pointer border-b border-line/70 last:border-0 hover:bg-hover/60 [&>td]:px-3 [&>td]:py-2.5"
                          onClick={() =>
                            navigate(`/services/${encodeURIComponent(s.name)}?window=${window}`)
                          }
                        >
                          <td className="!pl-4">
                            <ServiceChip name={s.name} link className="font-medium text-ink" />
                            {s.environment && (
                              <span className="ml-2 text-[11px] text-ink-3">{s.environment}</span>
                            )}
                          </td>
                          <td className="num text-right text-ink">
                            {s.requestCount.toLocaleString()}
                          </td>
                          <td className="num text-right text-ink-2">{formatRate(s.requestRate)}</td>
                          <td className="num text-right">
                            {s.errorCount > 0 ? (
                              <span className="inline-flex items-center gap-1 text-[#ff8a8d]">
                                <AlertTriangle className="size-3" aria-hidden />
                                {formatPercent(s.errorRate)}
                              </span>
                            ) : (
                              <span className="text-ink-2">{formatPercent(s.errorRate)}</span>
                            )}
                          </td>
                          <td className="num text-right text-ink-2">
                            {formatDuration(s.latency.p50)}
                          </td>
                          <td>
                            <div className="flex items-center gap-2">
                              <span className="num w-14 shrink-0 text-right text-ink">
                                {formatDuration(s.latency.p95)}
                              </span>
                              <InlineBar
                                value={s.latency.p95 ?? 0}
                                max={maxP95}
                                color={serviceColor(s.name)}
                              />
                            </div>
                          </td>
                          <td className="num text-right text-ink-2">
                            {formatDuration(s.latency.p99)}
                          </td>
                          <td className="!pr-4 text-right text-ink-3">
                            {s.lastSeen ? relativeTime(s.lastSeen) : '—'}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
