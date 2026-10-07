import { guard } from '@/server/auth';
import { ok, readJsonBody, route } from '@/server/http';
import { getPresetStore, type PresetInput } from '@/server/preset-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/chat/presets — every preset, newest first. */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    const presets = await getPresetStore().list();
    return ok({ presets });
  },
  { logAccess: false },
);

/** POST /api/chat/presets — persist the current playground state. */
export const POST = route(async ({ request }) => {
  await guard(request, { scope: 'write' });
  const body = await readJsonBody<Partial<PresetInput>>(request, 512 * 1024);
  const preset = await getPresetStore().create({
    name: String(body.name ?? ''),
    params: body.params as PresetInput['params'],
    messages: (body.messages ?? []) as PresetInput['messages'],
  });
  return ok({ preset }, { status: 201 });
});
