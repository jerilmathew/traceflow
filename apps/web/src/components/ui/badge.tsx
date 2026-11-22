import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 h-5 text-[11px] font-medium leading-none whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      variant: {
        neutral: 'border-line bg-raised text-ink-2',
        error: 'border-err/40 bg-err-soft text-[#ff8a8d]',
        ok: 'border-ok/35 bg-ok/10 text-[#6fd3a0]',
        warn: 'border-warn/35 bg-warn/10 text-[#f7c46b]',
        accent: 'border-accent/40 bg-accent/10 text-accent-strong',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
