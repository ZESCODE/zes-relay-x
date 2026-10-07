import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@/server/session-token';

/**
 * Edge middleware — the *UX* gate, not the security boundary.
 *
 * Responsibilities
 *   • Content-Security-Policy with a per-request nonce (Next injects the nonce
 *     into its own bootstrap scripts).
 *   • Redirect unauthenticated navigations to /login and signed-in users away
 *     from /login.
 *   • Reject unauthenticated /api/* calls early (the authoritative check —
 *     signature verification, scopes, CSRF comparison — happens in the Node
 *     route handlers, because the signing secret lives on disk and is not
 *     readable from the edge runtime).
 *   • Block cross-origin mutations (Origin/Host mismatch) and enforce the
 *     double-submit CSRF cookie.
 *   • Best-effort login throttling per IP (the exact limit is enforced again in
 *     the Node runtime by src/server/rate-limit.ts).
 */

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};

const PUBLIC_API = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/theme',
]);

const PUBLIC_PAGES = new Set(['/login', '/api']);

/** Cookie gate: presence + JWT shape. Full verification happens in Node. */
function looksLikeSessionCookie(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function buildCsp(nonce: string, isDev: boolean, frameAncestors: string): string {
  const scriptSrc = isDev
    ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;
  const connectSrc = isDev ? `'self' ws: wss: http: https:` : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    "worker-src 'self' blob:",
  ].join('; ');
}

const loginHits = new Map<string, number[]>();
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;

function loginThrottled(ip: string): boolean {
  const now = Date.now();
  const hits = (loginHits.get(ip) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
  if (hits.length >= LOGIN_LIMIT) {
    loginHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  loginHits.set(ip, hits);
  if (loginHits.size > 5000) {
    // Bounded memory: drop the oldest entries.
    const keys = [...loginHits.keys()].slice(0, 1000);
    for (const key of keys) loginHits.delete(key);
  }
  return false;
}

function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const isDev = process.env.NODE_ENV !== 'production';
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const frameAncestors = process.env.PANEL_FRAME_ANCESTORS?.trim() || "'none'";
  const csp = buildCsp(nonce, isDev, frameAncestors);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const decorated = (response: NextResponse): NextResponse => {
    response.headers.set('content-security-policy', csp);
    response.headers.set('x-nonce', nonce);
    return response;
  };

  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  const hasSession = looksLikeSessionCookie(sessionCookie);
  const hasBearer = (request.headers.get('authorization') ?? '').toLowerCase().startsWith('bearer ');
  const isApi = pathname.startsWith('/api/');
  const method = request.method.toUpperCase();
  const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  // ── cross-origin mutation guard ──────────────────────────────────────────
  if (isMutation) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    const forwardedHost =
      process.env.PANEL_TRUST_PROXY === 'true'
        ? request.headers
            .get('x-forwarded-host')
            ?.split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : null;
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        const allowed = new Set<string>([host, ...(forwardedHost ?? [])]);
        if (!allowed.has(originHost)) {
          return decorated(
            jsonError(403, 'forbidden', `Cross-origin request blocked (${origin} ≠ ${host}).`),
          );
        }
      } catch {
        return decorated(jsonError(403, 'forbidden', 'Malformed Origin header.'));
      }
    }
  }

  // ── login throttling ─────────────────────────────────────────────────────
  if (pathname === '/api/auth/login' && method === 'POST') {
    const ip =
      (process.env.PANEL_TRUST_PROXY === 'true'
        ? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        : null) ?? 'unknown';
    if (loginThrottled(ip)) {
      return decorated(
        jsonError(429, 'rate_limited', 'Too many login attempts. Try again in a minute.'),
      );
    }
  }

  // ── double-submit CSRF for cookie-authenticated mutations ────────────────
  if (isApi && isMutation && hasSession && !hasBearer && !pathname.startsWith('/api/auth/')) {
    const cookieToken = request.cookies.get(CSRF_COOKIE)?.value;
    const headerToken = request.headers.get(CSRF_HEADER);
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return decorated(
        jsonError(403, 'forbidden', 'CSRF token missing or mismatched — reload the panel.'),
      );
    }
  }

  // ── API gate ─────────────────────────────────────────────────────────────
  if (isApi) {
    if (PUBLIC_API.has(pathname)) {
      return decorated(
        NextResponse.next({ request: { headers: requestHeaders } }),
      );
    }
    if (!hasSession && !hasBearer) {
      return decorated(jsonError(401, 'unauthorized', 'Authentication required.'));
    }
    return decorated(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  // ── page gate ────────────────────────────────────────────────────────────
  const isPublicPage = PUBLIC_PAGES.has(pathname) || pathname.startsWith('/login');
  if (isPublicPage) {
    if (pathname === '/login' && hasSession) {
      const target = request.nextUrl.searchParams.get('next');
      const url = request.nextUrl.clone();
      url.pathname = target && target.startsWith('/') ? target : '/dashboard';
      url.search = '';
      return decorated(NextResponse.redirect(url));
    }
    return decorated(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(`${pathname}${search}`)}`;
    return decorated(NextResponse.redirect(url));
  }

  return decorated(NextResponse.next({ request: { headers: requestHeaders } }));
}
