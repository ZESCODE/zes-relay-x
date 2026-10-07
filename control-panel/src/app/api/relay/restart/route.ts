import type { RelayStatus } from '@/lib/types';
import { guard } from '@/server/auth';
import { ok, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { getRelayManager } from '@/server/relay-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Graceful restart (SIGTERM → 5s → SIGKILL, then spawn again). */
export const POST = route(async ({ request }) => {
  const context = await guard(request, { scope: 'write', rateLimit: 'admin' });
  const manager = getRelayManager();
  const status: RelayStatus = await manager.restart();
  getLogBus().push({
    source: 'system',
    level: 'info',
    message: `Restart requested by ${context.user.username} (relay state: ${status.state}).`,
  });
  return ok(status);
});
