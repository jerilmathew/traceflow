import type { InputHTMLAttributes, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const field =
  'h-7 rounded-md border border-line bg-panel px-2 text-xs text-ink placeholder:text-ink-3 transition-colors hover:border-line-strong focus:border-accent/70 focus:outline-none';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, className)} {...props} />;
}

/** Native select styled to match: fully keyboard/screen-reader accessible by default. */
export function NativeSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        field,
        'appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%2710%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%236f6f80%27 stroke-width=%272.5%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")] bg-[length:10px] bg-[right_8px_center] bg-no-repeat pr-6',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
