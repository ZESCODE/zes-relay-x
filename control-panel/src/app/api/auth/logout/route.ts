import { isSecureRequest, authenticate, cookieOptions } from '@/server/auth';
import { ok, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { CSRF_COOKIE, SESSION_COOKIE } from '@/server/session-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async ({ request }) => {
  const context = await authenticate(request);
  const response = ok({ loggedOut: true });
  // Clear both cookies; the CSRF cookie is deliberately non-httpOnly and
  // therefore always sent to the server, so clearing it is enough for the next
  // login to mint a fresh pair.
  const secure = isSecureRequest(request);
  response.cookies.set(
    SESSION_COOKIE,
    '',
    cookieOptions({ secure, maxAgeSeconds: 0, httpOnly: true }),
  );
  response.cookies.set(CSRF_COOKIE, '', cookieOptions({ secure, maxAgeSeconds: 0, httpOnly: false }));
  if (context) {
    getLogBus().push({
      source: 'system',
      level: 'info',
      message: `User "${context.user.username}" signed out.`,
    });
  }
  return response;
});
