import { guard } from '@/server/auth';
import { ok, route } from '@/server/http';
import { getRelayManager } from '@/server/relay-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function probe(request: Request) {
  await guard(request, { scope: 'read' });
  const manager = getRelayManager();
  const probe = await manager.health();
  return ok({
    ok: probe.ok,
    running: probe.ok,
    latencyMs: probe.latencyMs,
    status: probe.status,
    error: probe.error,
    checkedAt: probe.at,
    models: probe.modelCount,
  });
}

/** On-demand health probe (GET for scripts, POST for the UI button). */
export const GET = route(async ({ request }) => probe(request), { logAccess: false });
export const POST = route(async ({ request }) => probe(request), { logAccess: false });
