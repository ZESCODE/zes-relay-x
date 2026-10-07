import { guard } from '@/server/auth';
import { ok, route } from '@/server/http';
import { getMetrics } from '@/server/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Recent failures (newest first), clamped to the configured error buffer. */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    const url = new URL(request.url);
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 50;
    return ok(getMetrics().errorList(limit));
  },
  { logAccess: false },
);
