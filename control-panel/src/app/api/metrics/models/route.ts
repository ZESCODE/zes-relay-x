import type { ModelMetric } from '@/lib/types';
import { guard } from '@/server/auth';
import { ok, route } from '@/server/http';
import { getMetrics } from '@/server/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Per-model request/error/token/latency breakdown. */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    const models: ModelMetric[] = getMetrics().modelMetrics();
    return ok({ models });
  },
  { logAccess: false },
);
