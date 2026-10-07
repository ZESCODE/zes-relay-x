import clsx from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import type { FrostColor } from '@/lib/types';

export type CardTone = FrostColor | 'plain' | 'hero';

const TONES: Record<CardTone, string> = {
  plain: 'glass-card',
  hero: 'glass-card frost-grid',
  green: 'glass-frost-green',
  blue: 'glass-frost-blue',
  orange: 'glass-frost-orange',
  red: 'glass-frost-red',
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  padded?: boolean;
  interactive?: boolean;
}

export function Card({ tone = 'plain', padded = true, interactive, className, children, ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        TONES[tone],
        padded && 'p-4 sm:p-5',
        interactive && 'hover:-translate-y-0.5',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({ title, subtitle, icon, actions, className }: CardHeaderProps) {
  return (
    <div className={clsx('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="flex items-start gap-3">
        {icon ? (
          <span className="mt-0.5 flex size-8 items-center justify-center rounded-lg bg-white/10 text-white/80">
            {icon}
          </span>
        ) : null}
        <div>
          <h2 className="font-display text-sm font-semibold tracking-display text-white/90">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-white/45">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('text-sm text-white/70', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('mt-4 flex items-center justify-between gap-3', className)} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  hint,
  className,
}: {
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('mb-3 flex items-baseline justify-between gap-3', className)}>
      <h2 className="flex items-center gap-2 font-display text-base font-semibold tracking-display text-white/85">
        <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-blue-500/70" />
        {children}
      </h2>
      {hint ? <span className="text-xs text-white/40">{hint}</span> : null}
    </div>
  );
}

export default Card;
