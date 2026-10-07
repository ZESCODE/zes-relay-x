import { guard } from '@/server/auth';
import { ok, route } from '@/server/http';
import { collectSystemInfo } from '@/server/system';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Versions, hashes, data-dir size and the masked panel environment. */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'admin' });
    return ok(await collectSystemInfo());
  },
  { logAccess: false },
);
