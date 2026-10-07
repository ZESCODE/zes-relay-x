import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { guard } from '@/server/auth';
import { route } from '@/server/http';
import { getBackupService } from '@/server/backup';
import { getLogBus } from '@/server/log-bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

/** Download a backup archive. */
export const GET = route<Params>(
  async ({ request, params }) => {
    const context = await guard(request, { scope: 'admin' });
    const file = await getBackupService().resolvePath(params.id);
    const buffer = await readFile(file);
    getLogBus().push({
      source: 'system',
      level: 'warn',
      message: `Backup ${path.basename(file)} downloaded by ${context.user.username}.`,
    });
    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${path.basename(file)}"`,
        'content-length': String(buffer.length),
        'cache-control': 'no-store',
      },
    });
  },
  { logAccess: false },
);

/** Delete a backup archive. */
export const DELETE = route<Params>(async ({ request, params }) => {
  const context = await guard(request, { scope: 'admin' });
  const deleted = await getBackupService().delete(params.id);
  getLogBus().push({
    source: 'system',
    level: 'warn',
    message: `Backup ${params.id} deleted by ${context.user.username}.`,
  });
  return Response.json({ ok: true, data: { deleted } });
});
