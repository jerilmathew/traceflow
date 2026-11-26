import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { api, queryKeys } from '@/lib/api';

export function useDemo() {
  const meta = useQuery({
    queryKey: queryKeys.meta,
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: Infinity,
  });
  return meta.data?.demo ?? null;
}

/** Tells visitors what they are looking at; only shown on public demo instances. */
export function DemoNotice() {
  const demo = useDemo();
  if (!demo) return null;
  return (
    <div
      role="note"
      data-testid="demo-notice"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-accent/30 bg-accent/10 px-5 py-1.5 text-xs text-ink-2"
    >
      <FlaskConical className="size-3.5 shrink-0 text-accent" aria-hidden />
      <strong className="font-semibold text-ink">Demo environment</strong>
      <span>
        Real traces from three demo services handling generated requests. No real users or data
        {demo.retentionHours > 0 && `; traces are kept for ${demo.retentionHours} hours`}.
      </span>
      {demo.sourceUrl && (
        <a
          href={demo.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent-strong hover:underline"
        >
          View source
        </a>
      )}
    </div>
  );
}
