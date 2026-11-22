import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  TIME_WINDOWS,
  WINDOW_LABELS,
  WINDOW_SECONDS,
  isTimeWindow,
  type TimeWindow,
} from '@traceflow/shared';
import { ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorState, PageHeader, Panel } from '@/components/common';
import { TraceTable, type SortKey } from '@/components/trace-table';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { useLive } from '@/hooks/use-live';
import { api, queryKeys, type TraceQuery } from '@/lib/api';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

/** All filter state lives in the URL, so a filtered view can be bookmarked or shared. */
function useTraceFilters() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const range = get('range');
  const filters = {
    q: get('q'),
    service: get('service'),
    status: (['ok', 'error'].includes(get('status')) ? get('status') : 'all') as
      'ok' | 'error' | 'all',
    min: get('min'),
    max: get('max'),
    range: (isTimeWindow(range) ? range : 'all') as TimeWindow | 'all',
    sort: (['startTime', 'duration', 'spanCount'].includes(get('sort'))
      ? get('sort')
      : 'startTime') as SortKey,
    order: (get('order') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
    page: Math.max(1, Number(get('page')) || 1),
  };
  const update = (
    patch: Partial<Record<keyof typeof filters, string | number>>,
    resetPage = true,
  ) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === '' || v === undefined || v === 'all' || (k === 'page' && v === 1))
            next.delete(k);
          else next.set(k, String(v));
        }
        if (resetPage && !('page' in patch)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  return { filters, update };
}

export function TracesPage() {
  const { filters, update } = useTraceFilters();
  const { freshIds } = useLive();
  const [search, setSearch] = useState(filters.q);

  // Debounce free-text search so we don't query on every keystroke.
  useEffect(() => {
    if (search === filters.q) return;
    const t = setTimeout(() => update({ q: search }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query: TraceQuery = useMemo(() => {
    const num = (v: string) => (v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
    return {
      q: filters.q || undefined,
      service: filters.service || undefined,
      status: filters.status,
      minDurationMs: num(filters.min),
      maxDurationMs: num(filters.max),
      // Relative ranges are resolved per request so "last 15 minutes" stays relative.
      from: filters.range === 'all' ? undefined : `@${filters.range}`,
      sort: filters.sort,
      order: filters.order,
      page: filters.page,
      pageSize: PAGE_SIZE,
    };
  }, [
    filters.q,
    filters.service,
    filters.status,
    filters.min,
    filters.max,
    filters.range,
    filters.sort,
    filters.order,
    filters.page,
  ]);

  const traces = useQuery({
    queryKey: queryKeys.traces(query),
    queryFn: ({ signal }) => {
      const from = query.from?.startsWith('@')
        ? new Date(
            Date.now() - WINDOW_SECONDS[query.from.slice(1) as TimeWindow] * 1000,
          ).toISOString()
        : undefined;
      return api.traces({ ...query, from }, signal);
    },
    placeholderData: keepPreviousData,
  });
  const services = useQuery({
    queryKey: queryKeys.services('7d'),
    queryFn: ({ signal }) => api.services('7d', signal),
    staleTime: 60_000,
  });

  const total = traces.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = Boolean(
    filters.q ||
    filters.service ||
    filters.status !== 'all' ||
    filters.min ||
    filters.max ||
    filters.range !== 'all',
  );
  const invalidRange =
    filters.min !== '' && filters.max !== '' && Number(filters.min) > Number(filters.max);

  const onSort = (key: SortKey) =>
    update({ sort: key, order: filters.sort === key && filters.order === 'desc' ? 'asc' : 'desc' });

  return (
    <>
      <PageHeader
        title="Traces"
        subtitle={
          traces.data
            ? `${total.toLocaleString()} matching trace${total === 1 ? '' : 's'}`
            : 'Search and filter ingested traces'
        }
        actions={
          <Button
            onClick={() => void traces.refetch()}
            disabled={traces.isFetching}
            aria-label="Refresh traces"
          >
            <RefreshCw className={cn(traces.isFetching && 'animate-spin')} /> Refresh
          </Button>
        }
      />
      <div className="space-y-3 p-5">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search });
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-3"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Trace ID or operation…"
              aria-label="Search by trace id, operation or service"
              className="w-64 pl-7"
              maxLength={200}
            />
          </div>
          <NativeSelect
            aria-label="Service"
            value={filters.service}
            onChange={(e) => update({ service: e.target.value })}
            className="w-44"
          >
            <option value="">All services</option>
            {services.data?.items.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
          <div
            role="radiogroup"
            aria-label="Status"
            className="flex h-7 items-center rounded-md border border-line bg-panel p-0.5"
          >
            {(['all', 'ok', 'error'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={filters.status === s}
                onClick={() => update({ status: s })}
                className={cn(
                  'h-full rounded px-2.5 text-xs capitalize text-ink-3 hover:text-ink cursor-pointer',
                  filters.status === s && 'bg-raised text-ink',
                )}
              >
                {s === 'all' ? 'All' : s === 'ok' ? 'OK' : 'Errors'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-xs text-ink-3">
            <Input
              type="number"
              min={0}
              inputMode="decimal"
              aria-label="Minimum duration in milliseconds"
              placeholder="min ms"
              value={filters.min}
              onChange={(e) => update({ min: e.target.value })}
              className={cn('w-20', invalidRange && 'border-err')}
            />
            <span aria-hidden>–</span>
            <Input
              type="number"
              min={0}
              inputMode="decimal"
              aria-label="Maximum duration in milliseconds"
              placeholder="max ms"
              value={filters.max}
              onChange={(e) => update({ max: e.target.value })}
              className={cn('w-20', invalidRange && 'border-err')}
            />
          </div>
          <NativeSelect
            aria-label="Time range"
            value={filters.range}
            onChange={(e) => update({ range: e.target.value })}
            className="w-36"
          >
            <option value="all">All time</option>
            {TIME_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {WINDOW_LABELS[w]}
              </option>
            ))}
          </NativeSelect>
          {hasFilters && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setSearch('');
                update({ q: '', service: '', status: 'all', min: '', max: '', range: 'all' });
              }}
            >
              <X /> Clear
            </Button>
          )}
        </form>
        {invalidRange && (
          <p className="text-xs text-[#ff8a8d]">Minimum duration must not exceed the maximum.</p>
        )}

        <Panel>
          {traces.isError && !traces.data ? (
            <ErrorState error={traces.error} onRetry={() => void traces.refetch()} />
          ) : traces.data && traces.data.items.length === 0 ? (
            <EmptyState title={hasFilters ? 'No traces match these filters' : 'No traces yet'}>
              {hasFilters
                ? 'Try widening the time range or clearing filters.'
                : 'Run `pnpm demo:services` and `pnpm demo` to generate real traces.'}
            </EmptyState>
          ) : (
            <div className={cn('transition-opacity', traces.isPlaceholderData && 'opacity-60')}>
              <TraceTable
                traces={traces.data?.items ?? []}
                loading={!traces.data}
                fresh={freshIds}
                sort={{ key: filters.sort, order: filters.order }}
                onSort={onSort}
              />
            </div>
          )}
          {traces.data && total > 0 && (
            <nav
              aria-label="Pagination"
              className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-ink-3"
            >
              <span className="num">
                {(filters.page - 1) * PAGE_SIZE + 1}–{Math.min(filters.page * PAGE_SIZE, total)} of{' '}
                {total.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Previous page"
                  disabled={filters.page <= 1}
                  onClick={() => update({ page: filters.page - 1 }, false)}
                >
                  <ChevronLeft />
                </Button>
                <span className="num px-1">
                  Page {filters.page} / {pages}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Next page"
                  disabled={filters.page >= pages}
                  onClick={() => update({ page: filters.page + 1 }, false)}
                >
                  <ChevronRight />
                </Button>
              </div>
            </nav>
          )}
        </Panel>
      </div>
    </>
  );
}
