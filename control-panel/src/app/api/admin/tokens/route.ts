import type { TokenScope } from '@/lib/types';
import { guard } from '@/server/auth';
import { ApiHttpError, ok, readJsonBody, route } from '@/server/http';
import { getTokenStore } from '@/server/token-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPES: TokenScope[] = ['read', 'write', 'admin'];

interface CreateBody {
  name?: unknown;
  scopes?: unknown;
  expiresInDays?: unknown;
}

/** GET /api/admin/tokens — list (never returns the secret). */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'admin' });
    return ok({ tokens: await getTokenStore().list() });
  },
  { logAccess: false },
);

/** POST /api/admin/tokens — mint a token; the secret is returned exactly once. */
export const POST = route(async ({ request }) => {
  const context = await guard(request, { scope: 'admin' });
  if (context.via === 'token') {
    throw new ApiHttpError('forbidden', 'API tokens cannot mint other API tokens.', 403);
  }

  const body = await readJsonBody<CreateBody>(request, 8192);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 64) {
    throw new ApiHttpError('validation_failed', 'Token name must be 2–64 characters.', 422);
  }

  const requested = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
  const scopes = requested.filter((scope): scope is TokenScope => SCOPES.includes(scope as TokenScope));
  if (requested.length > 0 && scopes.length !== requested.length) {
    throw new ApiHttpError(
      'validation_failed',
      `Unknown scope. Allowed values: ${SCOPES.join(', ')}.`,
      422,
    );
  }

  const expiresInDays =
    body.expiresInDays === undefined || body.expiresInDays === null || body.expiresInDays === ''
      ? null
      : Number.parseInt(String(body.expiresInDays), 10);
  if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) {
    throw new ApiHttpError('validation_failed', 'expiresInDays must be between 1 and 3650.', 422);
  }

  const created = await getTokenStore().create({
    name,
    scopes: scopes.length > 0 ? scopes : ['read'],
    expiresInDays,
  });
  return ok(created, { status: 201 });
});
