import { env } from '@/server/env';
import { ok, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { getRelayManager } from '@/server/relay-manager';
import { getMetrics } from '@/server/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness probe for the *panel* (used by Docker healthchecks and uptime
 * monitors). Never requires authentication and never leaks configuration.
 */
export const GET = route(
  async () => {
    const manager = getRelayManager();
    const snapshot = manager.snapshotStatus();
    return ok({
      panel: 'up',
      version: env.panelVersion,
      node: process.version,
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      relay: {
        state: snapshot.state ?? 'stopped',
        running: snapshot.running ?? false,
        pid: snapshot.pid ?? null,
      },
      buffers: {
        logs: getLogBus().bufferSize,
        metricSamples: getMetrics().recentSamples(1).length,
      },
    });
  },
  { logAccess: false },
);
