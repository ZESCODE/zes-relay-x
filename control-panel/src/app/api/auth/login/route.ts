import type { MeResponse } from '@/lib/types';
import {
  cookieOptions,
  createSessionCookieValue,
  ensureAdmin,
  findUser,
  getSessionSecret,
  hashPassword,
  isSecureRequest,
  issueCsrfCookie,
  sessionMaxAgeSeconds,
  verifyPassword,
} from '@/server/auth';
import { env } from '@/server/env';
import { ApiHttpError, clientIp, ok, readJsonBody, route } from '@/server/http';
import { enforceRateLimit, getRateLimiter } from '@/server/rate-limit';
import { getLogBus } from '@/server/log-bus';
import { CSRF_COOKIE, SESSION_COOKIE, THEME_COOKIE } from '@/server/session-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

/**
 * A dummy hash keeps the failure path timing-comparable with the success path
 * (never reveal whether the username exists).
 */
let dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = await hashPassword('panel-dummy-password');
  return dummyHash;
}

export const POST = route(async ({ request }) => {
  const ip = clientIp(request);
  enforceRateLimit('login', ip);

  const body = await readJsonBody<LoginBody>(request, 8192);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (username === '' || password === '') {
    throw new ApiHttpError('bad_request', 'Username and password are required.', 400);
  }

  await ensureAdmin();
  await getSessionSecret();

  const user = await findUser(username);
  const valid = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, await getDummyHash());

  if (!user || !valid) {
    getLogBus().push({
      source: 'system',
      level: 'warn',
      message: `Failed login attempt for "${username || '(empty)'}" from ${ip}.`,
    });
    throw new ApiHttpError('unauthorized', 'Invalid username or password.', 401);
  }

  // Successful login clears the failure budget for this IP.
  getRateLimiter().reset(`login:${ip}`);

  const session = await createSessionCookieValue(user.username);
  const csrf = issueCsrfCookie();
  const secure = isSecureRequest(request);
  const maxAge = sessionMaxAgeSeconds();
  const theme = user.theme === 'light' ? 'light' : 'dark';

  const data: MeResponse = {
    authenticated: true,
    user: {
      username: user.username,
      role: 'admin',
      createdAt: user.createdAt,
      mustChangePassword: user.mustChangePassword,
    },
    via: 'session',
    csrfToken: csrf,
    theme,
    panelVersion: env.panelVersion,
  };

  const response = ok(data);
  response.cookies.set(SESSION_COOKIE, session, cookieOptions({ secure, maxAgeSeconds: maxAge, httpOnly: true }));
  response.cookies.set(CSRF_COOKIE, csrf, cookieOptions({ secure, maxAgeSeconds: maxAge, httpOnly: false }));
  response.cookies.set(THEME_COOKIE, theme, cookieOptions({ secure, maxAgeSeconds: 31_536_000, httpOnly: false }));

  getLogBus().push({
    source: 'system',
    level: 'info',
    message: `User "${user.username}" signed in from ${ip}.`,
  });

  return response;
});
