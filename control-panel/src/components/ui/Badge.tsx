import clsx from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import type { FrostColor } from '@/lib/types';

export type BadgeTone = FrostColor | 'neutral' | 'indigo';

const TONES: Record<BadgeTone, string> = {
  green: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
  blue: 'border-blue-500/40 bg-blue-500/15 text-blue-200',
  orange: 'border-orange-500/40 bg-orange-500/15 text-orange-200',
  red: 'border-red-500/40 bg-red-500/15 text-red-200',
  neutral: 'border-white/15 bg-white/10 text-white/70',
  indigo: 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
  icon?: ReactNode;
  size?: 'sm' | 'md';
}

export function Badge({
  tone = 'neutral',
  dot = false,
  icon,
  size = 'sm',
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border font-semibold',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={clsx('size-1.5 rounded-full bg-current', tone === 'neutral' ? '' : 'pulse-dot')}
        />
      ) : null}
      {icon}
      {children}
    </span>
  );
}

export default Badge;
