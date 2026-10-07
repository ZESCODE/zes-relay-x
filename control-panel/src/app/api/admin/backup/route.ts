import { guard } from '@/server/auth';
import { ok, readJsonBody, route } from '@/server/http';
import { getBackupService } from '@/server/backup';
import { getLogBus } from '@/server/log-bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateBody {
  includeSecrets?: unknown;
}

/** GET /api/admin/backup — list existing archives. */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'admin' });
    return ok(await getBackupService().list());
  },
  { logAccess: false },
);

/**
 * POST /api/admin/backup — archive data/ as a timestamped zip.
 * Secrets are excluded unless `includeSecrets: true` (the UI asks twice).
 */
export const POST = route(async ({ request }) => {
  const context = await guard(request, { scope: 'admin', rateLimit: 'admin' });
  const body = await readJsonBody<CreateBody>(request, 4096).catch(() => ({}) as CreateBody);
  const includeSecrets = body.includeSecrets === true;
  const backup = await getBackupService().create({ includeSecrets });
  getLogBus().push({
    source: 'system',
    level: 'info',
    message: `Backup ${backup.name} created by ${context.user.username} (${
      includeSecrets ? 'with' : 'without'
    } secrets).`,
  });
  return ok({ backup }, { status: 201 });
});
