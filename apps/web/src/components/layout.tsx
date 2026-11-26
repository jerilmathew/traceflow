import { useQuery } from '@tanstack/react-query';
import { Activity, GitFork, LayoutDashboard, ListTree, Pause, Play, Server } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { DemoNotice } from '@/components/demo-notice';
import { Tooltip } from '@/components/ui/tooltip';
import { useLive, type LiveStatus } from '@/hooks/use-live';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/traces', label: 'Traces', icon: ListTree, end: false },
  { to: '/map', label: 'Service map', icon: GitFork, end: false },
  { to: '/services', label: 'Services', icon: Server, end: false },
];

const STATUS_TEXT: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  paused: 'Paused',
};

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#15151b" stroke="#30303c" />
      <rect x="6" y="8" width="20" height="3" rx="1.5" fill="#9085e9" />
      <rect x="10" y="14.5" width="12" height="3" rx="1.5" fill="#3987e5" />
      <rect x="14" y="21" width="9" height="3" rx="1.5" fill="#22b8cf" />
    </svg>
  );
}

function LiveIndicator() {
  const { status, paused, setPaused } = useLive();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/api/health');
      return (await res.json().catch(() => ({ database: 'down' }))) as { database: 'up' | 'down' };
    },
    refetchInterval: 10_000,
    retry: false,
  });
  const dbDown = health.isError || health.data?.database === 'down';
  return (
    <div className="space-y-2 border-t border-line p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-ink-2" role="status" aria-live="polite">
          <span
            className={cn(
              'relative inline-flex size-2 rounded-full',
              status === 'live' ? 'bg-ok' : status === 'paused' ? 'bg-ink-3' : 'bg-warn',
            )}
          >
            {status === 'live' && (
              <span className="absolute inset-0 animate-ping rounded-full bg-ok/60" />
            )}
          </span>
          {STATUS_TEXT[status]}
        </span>
        <Tooltip content={paused ? 'Resume live updates' : 'Pause live updates'} side="right">
          <button
            type="button"
            onClick={() => setPaused(!paused)}
            aria-label={paused ? 'Resume live updates' : 'Pause live updates'}
            className="inline-flex size-6 items-center justify-center rounded text-ink-3 hover:bg-hover hover:text-ink cursor-pointer"
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2 text-ink-3">
        <Activity className="size-3.5" aria-hidden />
        {health.isPending ? (
          'Checking storage…'
        ) : dbDown ? (
          <span className="text-warn">Storage unavailable</span>
        ) : (
          'PostgreSQL connected'
        )}
      </div>
    </div>
  );
}

export function AppLayout() {
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-line bg-panel md:w-52 md:border-r md:border-b-0">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <Logo />
          <div>
            <div className="text-[13px] font-semibold tracking-tight">TraceFlow</div>
            <div className="text-[10px] text-ink-3">distributed tracing</div>
          </div>
        </div>
        <nav
          aria-label="Primary"
          className="flex gap-0.5 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:pb-0"
        >
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink',
                  isActive && 'bg-raised text-ink shadow-[inset_2px_0_0_var(--color-accent)]',
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden md:block">
          <LiveIndicator />
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <DemoNotice />
        <Outlet />
      </main>
    </div>
  );
}
