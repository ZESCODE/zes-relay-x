'use client';

import { Badge } from '@/components/ui/Badge';
import { formatRelative } from '@/lib/format';
import type { ErrorEntry } from '@/lib/types';

export interface ErrorFeedProps {
  errors: ErrorEntry[];
  compact?: boolean;
}

/** Newest-first list of failed requests with status, endpoint and message. */
export function ErrorFeed({ errors, compact = false }: ErrorFeedProps) {
  if (errors.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-white/40">
        No errors recorded. 🎉
      </p>
    );
  }

  return (
    <ul className={compact ? 'space-y-1.5' : 'space-y-2'}>
      {errors.map((error) => (
        <li
          key={error.id}
          className="glass-frost-red rounded-xl p-3 text-xs transition hover:brightness-110"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={error.status >= 500 ? 'red' : 'orange'}>{error.status}</Badge>
            <span className="font-mono text-[10px] text-white/45">{error.endpoint}</span>
            {error.model ? (
              <span className="font-mono text-[10px] text-white/55">{error.model}</span>
            ) : null}
            <span className="ml-auto text-[10px] text-white/40" title={error.at}>
              {formatRelative(error.at)}
            </span>
          </div>
          <p className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-red-100/85">
            {error.message}
          </p>
          {error.requestId ? (
            <p className="mt-1 font-mono text-[10px] text-white/35">request {error.requestId}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default ErrorFeed;
