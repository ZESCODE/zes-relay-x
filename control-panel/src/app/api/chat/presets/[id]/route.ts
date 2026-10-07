import { guard } from '@/server/auth';
import { ApiHttpError, ok, route } from '@/server/http';
import { getPresetStore } from '@/server/preset-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

export const GET = route<Params>(
  async ({ request, params }) => {
    await guard(request, { scope: 'read' });
    const preset = await getPresetStore().get(params.id);
    if (!preset) throw new ApiHttpError('not_found', `Preset ${params.id} does not exist.`, 404);
    return ok({ preset });
  },
  { logAccess: false },
);

export const DELETE = route<Params>(async ({ request, params }) => {
  await guard(request, { scope: 'write' });
  const deleted = await getPresetStore().remove(params.id);
  if (!deleted) throw new ApiHttpError('not_found', `Preset ${params.id} does not exist.`, 404);
  return ok({ deleted: true });
});
