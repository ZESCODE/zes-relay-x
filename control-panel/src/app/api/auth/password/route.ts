import { changePassword, guard } from '@/server/auth';
import { ApiHttpError, ok, readJsonBody, route } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
}

/** Rotate the signed-in user's password (admin page → Account). */
export const POST = route(async ({ request }) => {
  const context = await guard(request, { scope: 'admin', rateLimit: 'admin' });
  if (context.via === 'token') {
    throw new ApiHttpError(
      'forbidden',
      'Password changes require an interactive session — API tokens cannot rotate credentials.',
      403,
    );
  }

  const body = await readJsonBody<PasswordBody>(request, 8192);
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (newPassword.length < 10) {
    throw new ApiHttpError('validation_failed', 'New password must be at least 10 characters.', 422);
  }
  if (newPassword === currentPassword) {
    throw new ApiHttpError('validation_failed', 'New password must differ from the current one.', 422);
  }

  await changePassword(context.user.username, currentPassword, newPassword);
  return ok({ changed: true });
});
