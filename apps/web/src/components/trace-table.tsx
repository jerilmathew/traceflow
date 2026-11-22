import { formatDuration, shortId, type TraceSummary } from '@traceflow/shared';
import { ArrowDown, ArrowUp, ArrowUpDown, CircleDashed } from 'lucide-react';
import { memo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ServiceChip, StatusBadge } from '@/components/common';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { formatDateTime, relativeTime, cn } from '@/lib/utils';

export type SortKey = 'startTime' | 'duration' | 'spanCount';

interface Props {
  traces: TraceSummary[];
  loading?: boolean;
  fresh?: ReadonlySet<string>;
  sort?: { key: SortKey; order: 'asc' | 'desc' };
  onSort?: (key: SortKey) => void;
  compact?: boolean;
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort?: Props['sort'];
  onSort?: Props['onSort'];
  className?: string;
}) {
  if (!onSort) return <th className={className}>{label}</th>;
  const active = sort?.key === k;
  const Icon = !active ? ArrowUpDown : sort.order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className={className}
      aria-sort={active ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-ink cursor-pointer',
          active && 'text-ink',
        )}
      >
        {label}
        <Icon className="size-3" aria-hidden />
      </button>
    </th>
  );
}

const Row = memo(function Row({
  trace,
  maxDuration,
  fresh,
  compact,
}: {
  trace: TraceSummary;
  maxDuration: number;
  fresh: boolean;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const pct = maxDuration > 0 ? Math.max(1.5, (trace.durationMs / maxDuration) * 100) : 0;
  return (
    <tr
      onClick={() => navigate(`/traces/${trace.traceId}`)}
      className={cn(
        'group cursor-pointer border-b border-line/70 last:border-0 hover:bg-hover/60',
        fresh && 'animate-flash',
      )}
      data-testid="trace-row"
      data-trace-id={trace.traceId}
    >
      <td className="py-2 pl-4 pr-2">
        <Link
          to={`/traces/${trace.traceId}`}
          className="font-mono text-[12px] text-accent-strong hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {shortId(trace.traceId, 10)}
        </Link>
      </td>
      <td className="max-w-[260px] px-2 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-ink">
            {trace.rootOperation ?? '(unknown)'}
          </span>
          {!trace.hasRoot && (
            <Tooltip
              content={`Incomplete: root span not received${trace.orphanCount ? ` · ${trace.orphanCount} span(s) without parent` : ''}`}
            >
              <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-warn">
                <CircleDashed className="size-3" aria-hidden />
                partial
              </span>
            </Tooltip>
          )}
        </div>
      </td>
      <td className="max-w-[180px] px-2 py-2">
        {trace.rootService ? (
          <ServiceChip name={trace.rootService} />
        ) : (
          <span className="text-ink-3">—</span>
        )}
        {!compact && trace.services.length > 1 && (
          <span className="ml-1 text-[11px] text-ink-3">+{trace.services.length - 1}</span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-ink-2" title={trace.startTime}>
        <span className="num">
          {compact ? relativeTime(trace.startTime) : formatDateTime(trace.startTime)}
        </span>
      </td>
      <td className="w-40 px-2 py-2">
        <div className="flex items-center gap-2">
          <span className="num w-14 shrink-0 text-right text-ink">
            {formatDuration(trace.durationMs)}
          </span>
          <div className="h-1.5 flex-1 rounded-full bg-raised" aria-hidden>
            <div
              className={cn('h-full rounded-full', trace.status === 'error' ? 'bg-err' : 'bg-blue')}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </td>
      {!compact && <td className="num px-2 py-2 text-right text-ink-2">{trace.spanCount}</td>}
      <td className="py-2 pl-2 pr-4">
        <StatusBadge status={trace.status} count={trace.errorCount} />
      </td>
    </tr>
  );
});

export function TraceTable({ traces, loading, fresh, sort, onSort, compact }: Props) {
  const maxDuration = Math.max(0, ...traces.map((t) => t.durationMs));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-xs" data-testid="trace-table">
        <thead>
          <tr className="border-b border-line text-[11px] font-medium text-ink-3 [&>th]:h-8 [&>th]:px-2 [&>th]:font-medium">
            <th className="!pl-4">Trace ID</th>
            <th>Root operation</th>
            <th>Service</th>
            <SortHeader label="Start time" k="startTime" sort={sort} onSort={onSort} />
            <SortHeader label="Duration" k="duration" sort={sort} onSort={onSort} />
            {!compact && (
              <SortHeader
                label="Spans"
                k="spanCount"
                sort={sort}
                onSort={onSort}
                className="text-right"
              />
            )}
            <th className="!pr-4">Status</th>
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: compact ? 5 : 10 }, (_, i) => (
                <tr key={i} className="border-b border-line/70">
                  <td colSpan={compact ? 6 : 7} className="px-4 py-2.5">
                    <Skeleton className="h-3.5 w-full" />
                  </td>
                </tr>
              ))
            : traces.map((t) => (
                <Row
                  key={t.traceId}
                  trace={t}
                  maxDuration={maxDuration}
                  fresh={fresh?.has(t.traceId) ?? false}
                  compact={compact}
                />
              ))}
        </tbody>
      </table>
    </div>
  );
}
