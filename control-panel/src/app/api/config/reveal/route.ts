import type { ConfigKey } from '@/lib/types';
import { guard } from '@/server/auth';
import { getConfigStore, SECRET_KEYS } from '@/server/config-store';
import { ApiHttpError, ok, readJsonBody, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { maskSecret } from '@/server/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RevealBody {
  key?: unknown;
}

/**
 * Dedicated endpoint for reading a secret value out of `data/.env`.
 *
 * Every call is audited in the panel log (who, when, which key, masked digest)
 * — that is the reason this is not folded into `GET /api/config`.
 */
const reveal = route(async ({ request }) => {
  const context = await guard(request, { scope: 'admin' });
  const body = await readJsonBody<RevealBody>(request, 4096);
  const key = typeof body.key === 'string' ? (body.key as ConfigKey) : null;

  if (!key || !(SECRET_KEYS as string[]).includes(key)) {
    throw new ApiHttpError(
      'validation_failed',
      `Only secret keys can be revealed (${SECRET_KEYS.join(', ')}).`,
      422,
    );
  }

  const value = await getConfigStore().reveal(key);
  getLogBus().push({
    source: 'system',
    level: 'warn',
    message: `Secret ${key} revealed to ${context.user.username} (${maskSecret(value) || 'empty'}).`,
  });

  return ok({ key, value });
});

export const POST = reveal;
