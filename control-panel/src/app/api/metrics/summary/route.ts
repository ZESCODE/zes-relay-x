import type { MetricsSummary } from '@/lib/types';
import { guard } from '@/server/auth';
import { ok, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { getMetrics } from '@/server/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Aggregate counters, rates, percentiles and per-model breakdown. */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    const metrics = getMetrics();
    const summary: MetricsSummary = metrics.summary();
    // Surface the live log buffer size without coupling the modules.
    summary.buffers.logs = getLogBus().bufferSize;
    return ok(summary);
  },
  { logAccess: false },
);
