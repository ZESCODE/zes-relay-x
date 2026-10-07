import { getSessionSecret } from './auth';
import { verifySessionToken as verify, type SessionPayload } from './session-token';

/**
 * Server-component entry point for session checks.
 *
 * Centralised so `app/(panel)/layout.tsx` and `app/page.tsx` share one
 * implementation (and tests can stub a single module).
 */
export async function verifySessionCookie(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;
  const secret = await getSessionSecret();
  return verify(token, secret);
}

export { ensureAdmin, findUser, type PanelUserRecord } from './auth';
export { themeFromCookies, csrfFromCookies, readCookieFromHeader } from './auth';
export { SESSION_COOKIE, CSRF_COOKIE, THEME_COOKIE } from './session-token';
