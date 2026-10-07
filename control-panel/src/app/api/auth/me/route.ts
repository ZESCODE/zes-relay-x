import type { MeResponse } from '@/lib/types';
import {
  authenticate,
  cookieOptions,
  csrfFromCookies,
  isSecureRequest,
  issueCsrfCookie,
  sessionMaxAgeSeconds,
  themeFromCookies,
} from '@/server/auth';
import { env } from '@/server/env';
import { ok, route } from '@/server/http';
import { CSRF_COOKIE } from '@/server/session-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Identity probe used by the login page and the panel shell.
 * Always answers 200 — `authenticated: false` is not an error.
 */
export const GET = route(
  async ({ request }) => {
    const context = await authenticate(request);
    const existingCsrf = csrfFromCookies();

    // Mirror the CSRF value into the session record: if the cookie is missing
    // (e.g. cleared by the browser) issue a fresh one so the UI can mutate.
    const csrf = existingCsrf ?? issueCsrfCookie();

    const data: MeResponse = {
      authenticated: Boolean(context),
      user: context
        ? {
            username: context.user.username,
            role: 'admin',
            createdAt: context.user.createdAt,
            mustChangePassword: context.user.mustChangePassword,
          }
        : null,
      via: context?.via ?? null,
      tokenName: context?.tokenName,
      csrfToken: csrf,
      theme: themeFromCookies(),
      panelVersion: env.panelVersion,
    };

    const response = ok(data);
    if (context && !existingCsrf) {
      response.cookies.set(
        CSRF_COOKIE,
        csrf,
        cookieOptions({
          secure: isSecureRequest(request),
          maxAgeSeconds: sessionMaxAgeSeconds(),
          httpOnly: false,
        }),
      );
    }
    return response;
  },
  { logAccess: false },
);
