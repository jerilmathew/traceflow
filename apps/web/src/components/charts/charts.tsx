/**
 * Chart components (Recharts). Conventions:
 * - one y-axis per chart (volume and latency are separate charts, never dual-axis);
 * - recessive grid/axes, thin marks, hover tooltip on every chart;
 * - errors use the reserved error color *and* are named in legend/tooltip text;
 * - a visually-hidden table mirrors each chart for screen readers.
 */
import { formatDuration, type HistogramBucket, type TimeBucket } from '@traceflow/shared';
import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { STATUS_COLORS } from '@/lib/colors';

const AXIS = {
  stroke: 'transparent',
  tick: { fill: '#6f6f80', fontSize: 10 },
  tickLine: false,
} as const;
const GRID = { stroke: '#1f1f27', vertical: false } as const;
const OK_FILL = '#3987e5';

function bucketLabel(ts: string, bucketSeconds: number): string {
  const d = new Date(ts);
  if (bucketSeconds >= 3600 * 4)
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      hour12: false,
    });
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function TooltipCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: string; color?: string }>;
}) {
  return (
    <div className="rounded-md border border-line-strong bg-raised px-2.5 py-2 text-xs shadow-xl shadow-black/40">
      <div className="mb-1 font-medium text-ink">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 text-ink-2">
          <span className="flex items-center gap-1.5">
            {r.color && (
              <span className="size-2 rounded-[2px]" style={{ backgroundColor: r.color }} />
            )}
            {r.label}
          </span>
          <span className="num font-medium text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }: { items: Array<{ label: string; color: string; pattern?: boolean }> }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-ink-3">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-[2px]" style={{ backgroundColor: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function SrTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Request volume per bucket, split into successful and failed requests (stacked: they partition the total). */
export function VolumeChart({
  data,
  bucketSeconds,
  height = 160,
  unit = 'requests',
}: {
  data: TimeBucket[];
  bucketSeconds: number;
  height?: number;
  unit?: string;
}) {
  const rows = data.map((b) => ({
    ...b,
    ok: b.count - b.errors,
    label: bucketLabel(b.ts, bucketSeconds),
  }));
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <Legend
          items={[
            { label: 'Successful', color: OK_FILL },
            { label: 'Errors', color: STATUS_COLORS.err },
          ]}
        />
      </div>
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 4, right: 4, bottom: 0, left: -18 }}
            barCategoryGap={2}
          >
            <CartesianGrid {...GRID} />
            <XAxis dataKey="label" {...AXIS} minTickGap={36} />
            <YAxis {...AXIS} allowDecimals={false} width={44} />
            <Tooltip
              cursor={{ fill: '#ffffff08' }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                if (!active || !p) return null;
                return (
                  <TooltipCard
                    title={new Date(p.ts).toLocaleString()}
                    rows={[
                      { label: `Total ${unit}`, value: String(p.count) },
                      { label: 'Successful', value: String(p.ok), color: OK_FILL },
                      { label: 'Errors', value: String(p.errors), color: STATUS_COLORS.err },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="ok" stackId="v" fill={OK_FILL} isAnimationActive={false} />
            <Bar
              dataKey="errors"
              stackId="v"
              fill={STATUS_COLORS.err}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <SrTable
        caption={`${unit} per interval`}
        headers={['Interval start', 'Total', 'Errors']}
        rows={data.map((b) => [b.ts, b.count, b.errors])}
      />
    </div>
  );
}

/** p95 latency over time (single series, so the title names it and no legend is needed). */
export function LatencyChart({
  data,
  bucketSeconds,
  height = 160,
}: {
  data: TimeBucket[];
  bucketSeconds: number;
  height?: number;
}) {
  const rows = data.map((b) => ({ ...b, label: bucketLabel(b.ts, bucketSeconds) }));
  return (
    <div>
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="label" {...AXIS} minTickGap={36} />
            <YAxis {...AXIS} width={52} tickFormatter={(v: number) => formatDuration(v)} />
            <Tooltip
              cursor={{ stroke: '#3a3a48', strokeWidth: 1 }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                if (!active || !p) return null;
                return (
                  <TooltipCard
                    title={new Date(p.ts).toLocaleString()}
                    rows={[
                      { label: 'p95 latency', value: formatDuration(p.p95), color: '#9085e9' },
                      { label: 'Requests', value: String(p.count) },
                    ]}
                  />
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="p95"
              stroke="#9085e9"
              strokeWidth={2}
              // Sparse data: buckets without traffic have no p95, so isolated
              // points would vanish without a visible marker.
              dot={{ r: 2.5, fill: '#9085e9', strokeWidth: 0 }}
              activeDot={{ r: 4, stroke: '#0f0f13', strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <SrTable
        caption="p95 latency per interval"
        headers={['Interval start', 'p95 (ms)']}
        rows={data.map((b) => [b.ts, b.p95 ?? '—'])}
      />
    </div>
  );
}

export function HistogramChart({
  data,
  height = 170,
}: {
  data: HistogramBucket[];
  height?: number;
}) {
  const rows = data.map((b) => ({
    ...b,
    label: b.toMs === null ? `≥${formatDuration(b.fromMs)}` : `<${formatDuration(b.toMs)}`,
    range:
      b.toMs === null
        ? `≥ ${formatDuration(b.fromMs)}`
        : `${formatDuration(b.fromMs)} – ${formatDuration(b.toMs)}`,
  }));
  return (
    <div>
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 4, right: 4, bottom: 0, left: -18 }}
            barCategoryGap={2}
          >
            <CartesianGrid {...GRID} />
            <XAxis dataKey="label" {...AXIS} interval={1} />
            <YAxis {...AXIS} allowDecimals={false} width={44} />
            <Tooltip
              cursor={{ fill: '#ffffff08' }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                if (!active || !p) return null;
                return (
                  <TooltipCard
                    title={p.range}
                    rows={[{ label: 'Requests', value: String(p.count), color: '#3987e5' }]}
                  />
                );
              }}
            />
            <Bar dataKey="count" fill="#3987e5" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <SrTable
        caption="Latency distribution"
        headers={['Range', 'Requests']}
        rows={rows.map((r) => [r.range, r.count])}
      />
    </div>
  );
}
