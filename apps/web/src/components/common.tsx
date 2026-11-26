import { TIME_WINDOWS, WINDOW_LABELS, type TimeWindow } from '@traceflow/shared';
import { AlertTriangle, Check, CircleCheck, Copy, Inbox, RefreshCw, WifiOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { ApiRequestError } from '@/lib/api';
import { serviceColor } from '@/lib/colors';
import { cn } from '@/lib/utils';

/** Status is always icon + text, never color alone. */
export function StatusBadge({ status, count }: { status: 'ok' | 'error'; count?: number }) {
  return status === 'error' ? (
    <Badge variant="error">
      <AlertTriangle aria-hidden />
      Error{count && count > 1 ? ` ×${count}` : ''}
    </Badge>
  ) : (
    <Badge variant="ok">
      <CircleCheck aria-hidden />
      OK
    </Badge>
  );
}

export function ServiceDot({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-[2px]', className)}
      style={{ backgroundColor: serviceColor(name) }}
    />
  );
}

export function ServiceChip({
  name,
  link = false,
  className,
}: {
  name: string;
  link?: boolean;
  className?: string;
}) {
  const content = (
    <>
      <ServiceDot name={name} />
      <span className="truncate">{name}</span>
    </>
  );
  const classes = cn('inline-flex min-w-0 items-center gap-1.5 text-ink-2', className);
  return link ? (
    <Link
      to={`/services/${encodeURIComponent(name)}`}
      className={cn(classes, 'hover:text-ink')}
      onClick={(e) => e.stopPropagation()}
    >
      {content}
    </Link>
  ) : (
    <span className={classes}>{content}</span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-2.5">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <div className="mt-0.5 text-xs text-ink-3">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn('flex min-w-0 flex-col rounded-lg border border-line bg-panel', className)}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="text-xs font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-[11px] text-ink-3">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="flex size-9 items-center justify-center rounded-lg border border-line bg-raised text-ink-3">
        {icon ?? <Inbox className="size-4" />}
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="max-w-md text-xs leading-relaxed text-ink-3">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const offline = error instanceof ApiRequestError && (error.status === 0 || error.status === 503);
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center"
    >
      <div className="flex size-9 items-center justify-center rounded-lg border border-err/30 bg-err-soft text-[#ff8a8d]">
        {offline ? <WifiOff className="size-4" /> : <AlertTriangle className="size-4" />}
      </div>
      <p className="text-sm font-medium text-ink">
        {offline ? 'TraceFlow API unavailable' : 'Could not load data'}
      </p>
      <p className="max-w-md text-xs text-ink-3">
        {offline
          ? 'Check that the API and PostgreSQL are running (pnpm dev, pnpm db:up). Retrying automatically.'
          : message}
      </p>
      {onRetry && (
        <Button onClick={onRetry} className="mt-1">
          <RefreshCw /> Retry
        </Button>
      )}
    </div>
  );
}

export function WindowSelect({
  value,
  onChange,
}: {
  value: TimeWindow;
  onChange: (w: TimeWindow) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-3">
      <span className="sr-only">Time window</span>
      <NativeSelect
        value={value}
        onChange={(e) => onChange(e.target.value as TimeWindow)}
        aria-label="Time window"
        className="w-36"
      >
        {TIME_WINDOWS.map((w) => (
          <option key={w} value={w}>
            {WINDOW_LABELS[w]}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex size-5 items-center justify-center rounded text-ink-3 hover:bg-hover hover:text-ink cursor-pointer"
    >
      {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />}
    </button>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'error';
  icon?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          'num mt-1 truncate text-xl font-semibold tracking-tight',
          tone === 'error' ? 'text-[#ff8a8d]' : 'text-ink',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

/** Small horizontal bar for relative magnitudes inside tables. */
export function InlineBar({
  value,
  max,
  color = 'var(--color-blue)',
}: {
  value: number;
  max: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-raised" aria-hidden>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}
