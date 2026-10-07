import type { RelayStatus } from '@/lib/types';
import { guard } from '@/server/auth';
import { ok, readJsonBody, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { getRelayManager } from '@/server/relay-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StopBody {
  force?: unknown;
  confirmToken?: unknown;
}

/**
 * Stop the relay.
 *
 * A relay the panel did not spawn is **never** killed unless `force: true` is
 * combined with the confirmation token (`force-kill-external`), which the UI
 * only sends after two explicit confirmations.
 */
export const POST = route(async ({ request }) => {
  const context = await guard(request, { scope: 'write', rateLimit: 'admin' });
  const body = await readJsonBody<StopBody>(request).catch(() => ({}) as StopBody);
  const force = body.force === true;
  const confirmToken = typeof body.confirmToken === 'string' ? body.confirmToken : undefined;

  const manager = getRelayManager();
  const status: RelayStatus = await manager.stop({ force, confirmToken });

  getLogBus().push({
    source: 'system',
    level: force ? 'warn' : 'info',
    message: `Stop requested by ${context.user.username}${force ? ' with force-kill confirmation' : ''}.`,
  });

  return ok(status);
});
