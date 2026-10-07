import { guard } from '@/server/auth';
import { ApiHttpError, ok, route } from '@/server/http';
import { getTokenStore } from '@/server/token-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

export const GET = route<Params>(
  async ({ request, params }) => {
    await guard(request, { scope: 'admin' });
    const tokens = await getTokenStore().list();
    const token = tokens.find((item) => item.id === params.id);
    if (!token) throw new ApiHttpError('not_found', `Token ${params.id} does not exist.`, 404);
    return ok({ token });
  },
  { logAccess: false },
);

/** Revoke (soft delete — keeps the audit trail and the last-used timestamp). */
export const DELETE = route<Params>(async ({ request, params }) => {
  await guard(request, { scope: 'admin' });
  try {
    const token = await getTokenStore().revoke(params.id);
    return ok({ token });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown token')) {
      throw new ApiHttpError('not_found', `Token ${params.id} does not exist.`, 404);
    }
    throw error;
  }
});
