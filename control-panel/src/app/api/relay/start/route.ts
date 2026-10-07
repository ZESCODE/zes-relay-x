import type { RelayStatus } from '@/lib/types';
import { guard } from '@/server/auth';
import { ok, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { getRelayManager } from '@/server/relay-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Idempotent start.
 *
 * Already running (owned or adopted) ⇒ `200 { ok: true, data: { alreadyRunning: true } }`.
 */
export const POST = route(async ({ request }) => {
  const context = await guard(request, { scope: 'write', rateLimit: 'admin' });
  const manager = getRelayManager();
  const result = await manager.start();
  const status: RelayStatus = result.status;

  getLogBus().push({
    source: 'system',
    level: 'info',
    message: result.alreadyRunning
      ? `Start requested by ${context.user.username}: relay was already running.`
      : `Start requested by ${context.user.username}: relay spawned (pid ${status.pid}).`,
  });

  return ok(status);
});
