'use client';

import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { formatRelative, formatUptime } from '@/lib/format';
import type { RelayState, RelayStatus } from '@/lib/types';

export interface HealthBadgeProps {
  status: RelayStatus | null;
  /** Show the uptime next to the state. */
  showUptime?: boolean;
  className?: string;
}

const STATE_LABELS: Record<RelayState, string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  crashed: 'Crashed',
};

export function healthTone(status: RelayStatus | null): BadgeTone {
  if (!status) return 'neutral';
  if (status.state === 'running' && status.healthy) return 'green';
  if (status.state === 'starting' || status.state === 'stopping') return 'blue';
  if (status.state === 'crashed' || status.lastError) return 'red';
  return 'orange';
}

/** Relay health pill: state, ownership and last probe latency. */
export function HealthBadge({ status, showUptime = false, className }: HealthBadgeProps) {
  if (!status) {
    return (
      <Badge tone="neutral" dot className={className}>
        Unknown
      </Badge>
    );
  }

  const tone = healthTone(status);
  const label = STATE_LABELS[status.state] ?? status.state;
  const suffix = status.running
    ? status.owned
      ? 'healthy · managed'
      : 'healthy · external'
    : null;

  return (
    <span className={className}>
      <Badge
        tone={tone}
        dot
        size="md"
        title={
          status.lastHealthAt
            ? `Last probe ${formatRelative(status.lastHealthAt)} · ${status.lastHealthLatencyMs ?? '—'} ms`
            : 'Never probed'
        }
      >
        {label}
        {suffix ? <span className="font-normal opacity-75"> · {suffix}</span> : null}
        {showUptime && status.uptimeMs ? (
          <span className="font-normal opacity-75"> · up {formatUptime(status.uptimeMs)}</span>
        ) : null}
      </Badge>
    </span>
  );
}

export default HealthBadge;
