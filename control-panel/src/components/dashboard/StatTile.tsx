'use client';

import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { FrostColor } from '@/lib/types';
import { Sparkline } from '@/components/charts/Sparkline';

export interface StatTileProps {
  label: string;
  value: string;
  frost?: FrostColor;
  icon?: ReactNode;
  /** Delta badge text, e.g. "+12.5%". */
  change?: string | null;
  trend?: 'up' | 'down' | 'flat';
  hint?: ReactNode;
  sparkline?: number[];
  sparklineColor?: string;
  className?: string;
}

const TONE: Record<
  FrostColor,
  { card: string; icon: string; text: string; badge: string; spark: string }
> = {
  green: {
    card: 'glass-frost-green',
    icon: 'bg-emerald-500/15 text-emerald-300',
    text: 'text-emerald-300',
    badge: 'bg-emerald-500/15 text-emerald-300',
    spark: 'rgb(52 211 153)',
  },
  blue: {
    card: 'glass-frost-blue',
    icon: 'bg-blue-500/15 text-blue-300',
    text: 'text-blue-300',
    badge: 'bg-blue-500/15 text-blue-300',
    spark: 'rgb(96 165 250)',
  },
  orange: {
    card: 'glass-frost-orange',
    icon: 'bg-orange-500/15 text-orange-300',
    text: 'text-orange-300',
    badge: 'bg-orange-500/15 text-orange-300',
    spark: 'rgb(251 146 60)',
  },
  red: {
    card: 'glass-frost-red',
    icon: 'bg-red-500/15 text-red-300',
    text: 'text-red-300',
    badge: 'bg-red-500/15 text-red-300',
    spark: 'rgb(248 113 113)',
  },
};

const TREND_ARROW = { up: '↑', down: '↓', flat: '→' } as const;

/** Compact frost metric card with an icon slot, delta badge and sparkline. */
export function StatTile({
  label,
  value,
  frost = 'blue',
  icon,
  change,
  trend = 'flat',
  hint,
  sparkline,
  sparklineColor,
  className,
}: StatTileProps) {
  const tone = TONE[frost];
  return (
    <div className={clsx('rounded-2xl p-4 transition-all duration-300', tone.card, className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        {icon ? (
          <span
            className={clsx(
              'flex size-9 items-center justify-center rounded-lg backdrop-blur-sm',
              tone.icon,
            )}
          >
            {icon}
          </span>
        ) : (
          <span />
        )}
        {change ? (
          <span
            className={clsx(
              'flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold',
              tone.badge,
            )}
          >
            <span aria-hidden="true">{TREND_ARROW[trend]}</span>
            {change}
          </span>
        ) : null}
      </div>

      <p className="text-[10px] font-semibold uppercase tracking-widest text-white/60">{label}</p>
      <p className={clsx('font-display text-2xl font-bold tracking-display', tone.text)}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-white/45">{hint}</p> : null}

      {sparkline && sparkline.length > 1 ? (
        <div className="mt-3 opacity-80">
          <Sparkline
            values={sparkline}
            stroke={sparklineColor ?? tone.spark}
            ariaLabel={`${label} trend`}
            height={30}
          />
        </div>
      ) : null}
    </div>
  );
}

export default StatTile;
