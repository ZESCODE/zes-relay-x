import type { MetricRange } from '@/lib/types';
import { guard } from '@/server/auth';
import { ApiHttpError, ok, route } from '@/server/http';
import { getMetrics, isMetricRange } from '@/server/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bucketed time series for the dashboard charts (`?range=15m|1h|6h|24h`). */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    const url = new URL(request.url);
    const range = url.searchParams.get('range') ?? '1h';
    if (!isMetricRange(range)) {
      throw new ApiHttpError(
        'validation_failed',
        'range must be one of 15m, 1h, 6h, 24h.',
        422,
      );
    }
    return ok(getMetrics().timeseries(range as MetricRange));
  },
  { logAccess: false },
);
