import { authenticate, cookieOptions, isSecureRequest, setTheme } from '@/server/auth';
import { ApiHttpError, ok, readJsonBody, route } from '@/server/http';
import { THEME_COOKIE } from '@/server/session-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ThemeBody {
  theme?: unknown;
}

/**
 * Persists the light/dark preference in a cookie server-side so the root layout
 * can render the correct class on the first paint (no flash of wrong theme).
 */
export const POST = route(async ({ request }) => {
  const body = await readJsonBody<ThemeBody>(request, 1024);
  const theme = body.theme === 'light' ? 'light' : body.theme === 'dark' ? 'dark' : null;
  if (!theme) throw new ApiHttpError('validation_failed', 'theme must be "light" or "dark".', 422);

  const context = await authenticate(request);
  if (context?.via === 'session') {
    await setTheme(theme, context.user.username);
  }

  const response = ok({ theme });
  response.cookies.set(
    THEME_COOKIE,
    theme,
    cookieOptions({ secure: isSecureRequest(request), maxAgeSeconds: 31_536_000, httpOnly: false }),
  );
  return response;
});
