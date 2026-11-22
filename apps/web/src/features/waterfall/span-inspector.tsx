import { formatDuration, type AttributeValue, type SpanDto } from '@traceflow/shared';
import { AlertTriangle, CornerLeftUp, ScanSearch, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CopyButton, ServiceChip } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Telemetry attributes are untrusted input. They are only ever rendered as
 * React text nodes (auto-escaped) — never as HTML — and long values are
 * clipped with an explicit "show more".
 */
function AttrValue({ value }: { value: AttributeValue }) {
  const [expanded, setExpanded] = useState(false);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const long = text.length > 240;
  const tone =
    typeof value === 'number'
      ? 'text-cyan'
      : typeof value === 'boolean'
        ? 'text-accent-strong'
        : value === null
          ? 'text-ink-3'
          : 'text-ink';
  return (
    <span className={cn('break-all font-mono text-[11px]', tone)}>
      {long && !expanded ? `${text.slice(0, 240)}…` : text}
      {long && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="ml-1 text-accent hover:underline cursor-pointer"
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </span>
  );
}

function AttrTable({
  attrs,
  empty = 'None',
}: {
  attrs: Record<string, AttributeValue>;
  empty?: string;
}) {
  const entries = Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return <p className="text-[11px] text-ink-3">{empty}</p>;
  return (
    <dl className="divide-y divide-line/60 rounded-md border border-line">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[minmax(0,40%)_minmax(0,60%)] gap-2 px-2 py-1.5">
          <dt className="truncate font-mono text-[11px] text-ink-3" title={k}>
            {k}
          </dt>
          <dd className="min-w-0">
            <AttrValue value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Section({
  title,
  children,
  count,
}: {
  title: string;
  children: ReactNode;
  count?: number;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        {title}
        {count !== undefined && (
          <span className="num rounded bg-raised px-1 text-ink-3">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

export interface InspectorProps {
  span: SpanDto;
  selfMs: number;
  criticalMs: number;
  parentMissing: boolean;
  hasParent: boolean;
  onClose: () => void;
  onSelectParent: () => void;
  onZoom: () => void;
}

export function SpanInspector({
  span,
  selfMs,
  criticalMs,
  parentMissing,
  hasParent,
  onClose,
  onSelectParent,
  onZoom,
}: InspectorProps) {
  const [showResource, setShowResource] = useState(false);
  const isError = span.statusCode === 'error';
  return (
    <aside
      aria-label="Span details"
      className="flex h-full min-h-0 flex-col"
      data-testid="span-inspector"
    >
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="break-words text-[13px] font-semibold text-ink">{span.operationName}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <ServiceChip name={span.service} link className="text-xs" />
            <Badge>{span.kind}</Badge>
            {isError ? (
              <Badge variant="error">
                <AlertTriangle aria-hidden /> Error
              </Badge>
            ) : (
              <Badge variant={span.statusCode === 'ok' ? 'ok' : 'neutral'}>
                {span.statusCode === 'ok' ? 'OK' : 'Unset'}
              </Badge>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close span details">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line text-xs">
          {[
            ['Duration', formatDuration(span.durationMs)],
            ['Starts at', `+${formatDuration(span.offsetMs)}`],
            ['Self time', formatDuration(selfMs)],
            ['On critical path', criticalMs > 0 ? formatDuration(criticalMs) : 'No'],
          ].map(([label, value]) => (
            <div key={label} className="bg-panel px-2.5 py-2">
              <dt className="text-[10px] uppercase tracking-wide text-ink-3">{label}</dt>
              <dd className="num mt-0.5 font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        {isError && span.statusMessage && (
          <div
            role="note"
            className="rounded-md border border-err/35 bg-err-soft px-3 py-2 text-xs text-[#ffb4b6]"
          >
            <div className="mb-0.5 flex items-center gap-1.5 font-medium text-[#ff8a8d]">
              <AlertTriangle className="size-3.5" aria-hidden /> Status message
            </div>
            <span className="break-words font-mono text-[11px]">{span.statusMessage}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={onZoom}>
            <ScanSearch /> Zoom timeline to span
          </Button>
          {hasParent && !parentMissing && (
            <Button onClick={onSelectParent}>
              <CornerLeftUp /> Select parent
            </Button>
          )}
        </div>

        <Section title="Identifiers">
          <dl className="space-y-1 text-[11px]">
            {[
              ['Span ID', span.spanId],
              ['Parent span ID', span.parentSpanId ?? '— (root span)'],
              ['Trace ID', span.traceId],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-2">
                <dt className="text-ink-3">{label}</dt>
                <dd className="flex min-w-0 items-center gap-1 font-mono text-ink-2">
                  <span className="truncate">{value}</span>
                  {value && !value.startsWith('—') && (
                    <CopyButton value={value} label={`Copy ${label}`} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {parentMissing && (
            <p className="rounded-md border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-[11px] text-[#f7c46b]">
              The parent span has not been received (still in flight, dropped, or emitted by an
              uninstrumented hop). This span is shown at the top level.
            </p>
          )}
        </Section>

        <Section title="Attributes" count={Object.keys(span.attributes).length}>
          <AttrTable attrs={span.attributes} />
        </Section>

        <Section title="Events" count={span.events.length}>
          {span.events.length === 0 ? (
            <p className="text-[11px] text-ink-3">None</p>
          ) : (
            <ol className="space-y-2">
              {span.events.map((e, i) => (
                <li
                  key={i}
                  className={cn(
                    'rounded-md border px-2.5 py-2',
                    e.name === 'exception' ? 'border-err/35 bg-err-soft' : 'border-line',
                  )}
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                    <span
                      className={cn(
                        'flex items-center gap-1.5 font-medium',
                        e.name === 'exception' ? 'text-[#ff8a8d]' : 'text-ink',
                      )}
                    >
                      {e.name === 'exception' && <AlertTriangle className="size-3.5" aria-hidden />}
                      {e.name}
                    </span>
                    <span className="num text-[11px] text-ink-3">
                      +{formatDuration(e.offsetMs)}
                    </span>
                  </div>
                  <AttrTable attrs={e.attributes} empty="No attributes" />
                </li>
              ))}
            </ol>
          )}
        </Section>

        {span.links.length > 0 && (
          <Section title="Links" count={span.links.length}>
            <ul className="space-y-1 font-mono text-[11px] text-ink-2">
              {span.links.map((l) => (
                <li key={`${l.traceId}-${l.spanId}`}>
                  {l.traceId.slice(0, 12)}… / {l.spanId}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Resource" count={Object.keys(span.resourceAttributes).length}>
          <button
            type="button"
            onClick={() => setShowResource(!showResource)}
            className="text-[11px] text-accent hover:underline cursor-pointer"
          >
            {showResource ? 'Hide resource attributes' : 'Show resource attributes'}
          </button>
          {showResource && <AttrTable attrs={span.resourceAttributes} />}
          {span.scopeName && (
            <p className="text-[11px] text-ink-3">
              Instrumentation scope: <span className="font-mono">{span.scopeName}</span>
            </p>
          )}
        </Section>
      </div>
    </aside>
  );
}
