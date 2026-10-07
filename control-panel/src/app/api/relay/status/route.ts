import type { RelayStatus } from '@/lib/types';
import { guard } from '@/server/auth';
import { ok, route } from '@/server/http';
import { getRelayManager } from '@/server/relay-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Full lifecycle snapshot: state, pid, health, events and effective config. */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    const manager = getRelayManager();
    await manager.ensureInit();
    const status: RelayStatus = await manager.status();
    return ok(status);
  },
  { logAccess: false },
);
