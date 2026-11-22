/**
 * Trace waterfall.
 *
 * - The span tree is rebuilt from parent ids (`buildTraceTree`), tolerating
 *   missing parents and malformed cycles, then flattened in pre-order.
 * - Rows are virtualised, so a 10,000-span trace renders ~40 DOM rows.
 * - Bars are positioned from exact server-computed offsets: left = offset,
 *   width = duration, both relative to the visible [start, end] window.
 * - The minimap brush (or "zoom to span") narrows that window.
 * - Critical-path mode dims everything that did not determine end-to-end latency.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  buildTraceTree,
  criticalPath,
  flattenTree,
  formatDuration,
  selfTimeMs,
  type SpanDto,
  type TraceTreeNode,
} from '@traceflow/shared';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleDashed,
  Route,
  ZoomOut,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { serviceColor } from '@/lib/colors';
import { cn } from '@/lib/utils';
import { SpanInspector } from './span-inspector';
import { placement, ticks, type ViewRange } from './timeline';

const ROW_HEIGHT = 30;
const NAME_COL = 'minmax(240px, 34%)';
type Node = TraceTreeNode<SpanDto>;

interface WaterfallProps {
  spans: SpanDto[];
  totalMs: number;
  selectedId: string | null;
  onSelect: (spanId: string | null) => void;
}

export function Waterfall({ spans, totalMs, selectedId, onSelect }: WaterfallProps) {
  const tree = useMemo(() => buildTraceTree(spans), [spans]);
  const timing = useMemo(() => {
    const self = new Map<string, number>();
    for (const [id, node] of tree.byId) self.set(id, selfTimeMs(node));
    return { self, critical: criticalPath(tree.roots) };
  }, [tree]);

  // Trace extent: max span end (children may outlive the root).
  const extent = useMemo(
    () => Math.max(totalMs, ...spans.map((s) => s.offsetMs + s.durationMs)),
    [spans, totalMs],
  );
  const [view, setView] = useState<ViewRange>({ start: 0, end: extent });
  useEffect(() => setView({ start: 0, end: extent }), [extent]);
  const zoomed = view.start > 0 || view.end < extent;

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [criticalOnly, setCriticalOnly] = useState(false);
  const rows = useMemo(() => flattenTree(tree.roots, collapsed), [tree, collapsed]);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const selectedIndex = rows.findIndex((r) => r.node.span.spanId === selectedId);
  const selectedNode = selectedId ? tree.byId.get(selectedId) : undefined;

  // Keep the selected row visible when selection changes from elsewhere (e.g. "select parent").
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedIndex, virtualizer]);

  // Ensure ancestors of the selected span are expanded.
  useEffect(() => {
    if (!selectedId) return;
    const ancestors: string[] = [];
    let cursor = tree.byId.get(selectedId);
    while (cursor?.span.parentSpanId) {
      const parent = tree.byId.get(cursor.span.parentSpanId);
      if (!parent) break;
      ancestors.push(parent.span.spanId);
      cursor = parent;
    }
    if (ancestors.some((a) => collapsed.has(a))) {
      setCollapsed((prev) => new Set([...prev].filter((id) => !ancestors.includes(id))));
    }
  }, [selectedId, tree, collapsed]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = selectedIndex >= 0 ? selectedIndex : -1;
    const row = rows[current];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(
        rows.length - 1,
        Math.max(0, current + (e.key === 'ArrowDown' ? 1 : -1)),
      );
      onSelect(rows[next]!.node.span.spanId);
    } else if (e.key === 'ArrowRight' && row?.hasChildren && row.collapsed) {
      toggle(row.node.span.spanId);
    } else if (e.key === 'ArrowLeft' && row?.hasChildren && !row.collapsed) {
      toggle(row.node.span.spanId);
    } else if (e.key === 'Escape') {
      onSelect(null);
    }
  };

  const tickValues = useMemo(() => ticks(view), [view]);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row" data-testid="waterfall">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
          <Button variant="ghost" onClick={() => setCollapsed(new Set())}>
            <ChevronsUpDown /> Expand all
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              setCollapsed(
                new Set(
                  [...tree.byId.values()]
                    .filter((n) => n.children.length > 0 && n.depth > 0)
                    .map((n) => n.span.spanId),
                ),
              )
            }
          >
            <ChevronsDownUp /> Collapse
          </Button>
          <Tooltip content="Highlight the chain of spans that determined end-to-end latency">
            <Button
              variant={criticalOnly ? 'subtle' : 'ghost'}
              aria-pressed={criticalOnly}
              onClick={() => setCriticalOnly(!criticalOnly)}
            >
              <Route className={cn(criticalOnly && 'text-accent')} /> Critical path
            </Button>
          </Tooltip>
          <div className="ml-auto flex items-center gap-2 text-[11px] text-ink-3">
            <span className="num">
              {zoomed
                ? `Viewing ${formatDuration(view.start)} – ${formatDuration(view.end)} of ${formatDuration(extent)}`
                : 'Drag on the minimap to zoom'}
            </span>
            {zoomed && (
              <Button onClick={() => setView({ start: 0, end: extent })}>
                <ZoomOut /> Reset zoom
              </Button>
            )}
          </div>
        </div>

        <Minimap
          rows={rows.map((r) => r.node)}
          allSpans={spans}
          extent={extent}
          view={view}
          onChange={setView}
        />

        {/* Header: column label + time ruler */}
        <div
          className="grid h-7 shrink-0 border-b border-line text-[10px] text-ink-3"
          style={{ gridTemplateColumns: `${NAME_COL} 1fr` }}
        >
          <div className="flex items-center border-r border-line px-4 font-medium uppercase tracking-wide">
            Service · operation
          </div>
          <div className="relative mr-16 ml-2">
            {tickValues.map((t) => {
              const left = ((t - view.start) / (view.end - view.start)) * 100;
              return (
                <span
                  key={t}
                  className="num absolute top-1/2 -translate-y-1/2 whitespace-nowrap"
                  style={{
                    left: `${left}%`,
                    transform: `translate(${left > 95 ? '-100%' : left < 3 ? '0' : '-50%'}, -50%)`,
                  }}
                >
                  {formatDuration(t)}
                </span>
              );
            })}
          </div>
        </div>

        {/* Rows */}
        <div
          ref={scrollRef}
          role="tree"
          aria-label="Trace spans"
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="relative min-h-0 flex-1 overflow-auto focus-visible:outline-offset-[-2px]"
        >
          <div style={{ height: virtualizer.getTotalSize() }} className="relative">
            {/* Tick grid lines, drawn once behind all rows */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 grid"
              style={{ gridTemplateColumns: `${NAME_COL} 1fr` }}
            >
              <div className="border-r border-line" />
              <div className="relative mr-16 ml-2">
                {tickValues.map((t) => (
                  <span
                    key={t}
                    className="absolute inset-y-0 w-px bg-line/60"
                    style={{ left: `${((t - view.start) / (view.end - view.start)) * 100}%` }}
                  />
                ))}
              </div>
            </div>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              const id = row.node.span.spanId;
              return (
                <SpanRow
                  key={id}
                  node={row.node}
                  top={item.start}
                  hasChildren={row.hasChildren}
                  collapsed={row.collapsed}
                  selected={id === selectedId}
                  view={view}
                  critical={(timing.critical.get(id) ?? 0) > 0}
                  dim={criticalOnly && !((timing.critical.get(id) ?? 0) > 0)}
                  onToggle={toggle}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        </div>
      </div>

      {selectedNode && (
        <div className="max-h-[60vh] shrink-0 border-t border-line bg-panel lg:max-h-none lg:w-[400px] lg:border-t-0 lg:border-l">
          <SpanInspector
            span={selectedNode.span}
            selfMs={timing.self.get(selectedNode.span.spanId) ?? 0}
            criticalMs={timing.critical.get(selectedNode.span.spanId) ?? 0}
            parentMissing={selectedNode.orphan}
            hasParent={Boolean(selectedNode.span.parentSpanId)}
            onClose={() => onSelect(null)}
            onSelectParent={() =>
              selectedNode.span.parentSpanId && onSelect(selectedNode.span.parentSpanId)
            }
            onZoom={() => {
              const s = selectedNode.span;
              const pad = Math.max(s.durationMs * 0.08, extent * 0.002);
              setView({
                start: Math.max(0, s.offsetMs - pad),
                end: Math.min(extent, s.offsetMs + s.durationMs + pad) || extent,
              });
            }}
          />
        </div>
      )}
    </div>
  );
}

interface RowProps {
  node: Node;
  top: number;
  hasChildren: boolean;
  collapsed: boolean;
  selected: boolean;
  critical: boolean;
  dim: boolean;
  view: ViewRange;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}

const SpanRow = memo(function SpanRow({
  node,
  top,
  hasChildren,
  collapsed,
  selected,
  critical,
  dim,
  view,
  onToggle,
  onSelect,
}: RowProps) {
  const span = node.span;
  const color = serviceColor(span.service);
  const isError = span.statusCode === 'error';
  const { left, width, visible } = placement(span.offsetMs, span.durationMs, view);
  // Label goes right of the bar; if there's no room, left of it; if the bar
  // spans nearly the whole view, inside its right end on a dark chip.
  const labelMode: 'after' | 'before' | 'inside' =
    left + width <= 82 ? 'after' : left >= 14 ? 'before' : 'inside';

  return (
    <div
      role="treeitem"
      aria-level={node.depth + 1}
      aria-expanded={hasChildren ? !collapsed : undefined}
      aria-selected={selected}
      data-testid="span-row"
      data-span-id={span.spanId}
      data-service={span.service}
      data-depth={node.depth}
      data-error={isError || undefined}
      data-critical={critical || undefined}
      onClick={() => onSelect(span.spanId)}
      className={cn(
        'absolute inset-x-0 grid cursor-pointer border-b border-line/40 transition-colors hover:bg-hover/50',
        selected && 'bg-raised hover:bg-raised',
      )}
      style={{ top, height: ROW_HEIGHT, gridTemplateColumns: `${NAME_COL} 1fr` }}
    >
      {/* Name column */}
      <div
        className={cn(
          'flex min-w-0 items-center gap-1 border-r border-line pr-2',
          selected && 'shadow-[inset_2px_0_0_var(--color-accent)]',
        )}
      >
        <span
          aria-hidden
          className="flex h-full shrink-0 self-stretch"
          style={{ width: 8 + node.depth * 14 }}
        >
          {Array.from({ length: node.depth }, (_, i) => (
            <span
              key={i}
              className="h-full border-r border-line/70"
              style={{ width: 14, marginLeft: i === 0 ? 8 : 0 }}
            />
          ))}
        </span>
        {hasChildren ? (
          <button
            type="button"
            aria-label={
              collapsed ? `Expand ${span.operationName}` : `Collapse ${span.operationName}`
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggle(span.spanId);
            }}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-hover hover:text-ink cursor-pointer"
          >
            {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <span
          aria-hidden
          className="h-3.5 w-[3px] shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="min-w-0 truncate text-xs">
          <span className="text-ink-3">{span.service}</span>{' '}
          <span className={cn('font-medium', isError ? 'text-[#ff9a9c]' : 'text-ink')}>
            {span.operationName}
          </span>
        </span>
        {isError && (
          <span className="inline-flex shrink-0 items-center text-err" title="Span status: error">
            <AlertTriangle className="size-3.5" aria-hidden />
            <span className="sr-only">error</span>
          </span>
        )}
        {node.orphan && (
          <Tooltip content={`Parent span ${span.parentSpanId} has not been received`}>
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm border border-warn/30 px-1 text-[10px] text-warn">
              <CircleDashed className="size-2.5" aria-hidden /> parent missing
            </span>
          </Tooltip>
        )}
        {collapsed && (
          <span className="num shrink-0 text-[10px] text-ink-3">+{countDescendants(node)}</span>
        )}
      </div>

      {/* Timeline column */}
      <div className={cn('relative mr-16 ml-2 transition-opacity', dim && 'opacity-30')}>
        {visible && (
          <>
            <div
              className={cn(
                'absolute top-1/2 h-3 -translate-y-1/2 rounded-[3px]',
                isError && 'ring-1 ring-err ring-offset-1 ring-offset-panel',
              )}
              style={{
                left: `${left}%`,
                width: `max(${width}%, 2px)`,
                backgroundColor: color,
                backgroundImage: isError
                  ? 'repeating-linear-gradient(135deg, transparent 0 4px, rgba(0,0,0,.28) 4px 6px)'
                  : undefined,
              }}
              data-testid="span-bar"
            >
              {span.events.map((ev, i) => {
                const pos =
                  span.durationMs > 0 ? ((ev.offsetMs - span.offsetMs) / span.durationMs) * 100 : 0;
                return (
                  <span
                    key={i}
                    title={`${ev.name} at +${formatDuration(ev.offsetMs)}`}
                    className={cn(
                      'absolute -top-0.5 h-4 w-0.5 rounded-full',
                      ev.name === 'exception' ? 'bg-[#ffb4b6]' : 'bg-white/80',
                    )}
                    style={{ left: `${Math.min(100, Math.max(0, pos))}%` }}
                  />
                );
              })}
            </div>
            <span
              className={cn(
                'num absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px]',
                critical ? 'text-ink' : 'text-ink-2',
                labelMode === 'inside' && 'rounded-sm bg-canvas/80 px-1 leading-[14px] text-ink',
              )}
              style={
                labelMode === 'after'
                  ? { left: `calc(${left + width}% + 6px)` }
                  : labelMode === 'before'
                    ? { right: `${100 - left}%`, paddingRight: 6 }
                    : { right: `calc(${100 - left - width}% + 4px)` }
              }
            >
              {formatDuration(span.durationMs)}
            </span>
          </>
        )}
      </div>
    </div>
  );
});

function countDescendants(node: Node): number {
  let n = 0;
  const stack = [...node.children];
  while (stack.length) {
    const c = stack.pop()!;
    n++;
    stack.push(...c.children);
  }
  return n;
}

/** Overview of the whole trace on a canvas, with a draggable zoom brush. */
function Minimap({
  rows,
  allSpans,
  extent,
  view,
  onChange,
}: {
  rows: Node[];
  allSpans: SpanDto[];
  extent: number;
  view: ViewRange;
  onChange: (v: ViewRange) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const HEIGHT = 40;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      canvas.width = width * dpr;
      canvas.height = HEIGHT * dpr;
      canvas.style.width = `${width}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, HEIGHT);
      const list = rows.length > 0 ? rows.map((r) => r.span) : allSpans;
      const rowH = Math.max(1, Math.min(4, (HEIGHT - 6) / Math.max(1, list.length)));
      list.forEach((s, i) => {
        const x = (s.offsetMs / extent) * width;
        const w = Math.max(1, (s.durationMs / extent) * width);
        ctx.fillStyle = s.statusCode === 'error' ? '#e5484d' : serviceColor(s.service);
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x, 3 + (i * (HEIGHT - 6)) / Math.max(1, list.length), w, rowH);
      });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [rows, allSpans, extent]);

  const toMs = (clientX: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return Math.min(extent, Math.max(0, ((clientX - rect.left) / rect.width) * extent));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const ms = toMs(e.clientX);
    setDrag({ from: ms, to: ms });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) =>
    drag && setDrag({ ...drag, to: toMs(e.clientX) });
  const onPointerUp = () => {
    if (drag) {
      const start = Math.min(drag.from, drag.to);
      const end = Math.max(drag.from, drag.to);
      // A click (no real drag) resets; a drag selects the range.
      if (end - start > extent * 0.005) onChange({ start, end });
      else onChange({ start: 0, end: extent });
    }
    setDrag(null);
  };

  const sel = drag
    ? { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) }
    : view;
  const pct = (ms: number) => `${(ms / extent) * 100}%`;
  return (
    <div className="shrink-0 border-b border-line px-4 py-2">
      <div
        ref={wrapRef}
        role="slider"
        aria-label="Timeline zoom: drag to select a time range"
        aria-valuemin={0}
        aria-valuemax={Math.round(extent)}
        aria-valuenow={Math.round(view.start)}
        aria-valuetext={`${formatDuration(view.start)} to ${formatDuration(view.end)}`}
        tabIndex={-1}
        className="relative cursor-crosshair select-none touch-none rounded border border-line bg-canvas"
        style={{ height: HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => onChange({ start: 0, end: extent })}
        data-testid="minimap"
      >
        <canvas ref={canvasRef} className="absolute inset-0" aria-hidden />
        {(drag || view.start > 0 || view.end < extent) && (
          <>
            <div
              className="absolute inset-y-0 left-0 bg-canvas/70"
              style={{ width: pct(sel.start) }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-canvas/70"
              style={{ left: pct(sel.end) }}
            />
            <div
              className="absolute inset-y-0 border-x border-accent bg-accent/10"
              style={{ left: pct(sel.start), width: pct(sel.end - sel.start) }}
            />
          </>
        )}
      </div>
    </div>
  );
}
