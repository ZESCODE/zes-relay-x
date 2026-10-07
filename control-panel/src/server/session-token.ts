import { SignJWT, jwtVerify } from 'jose';
import { env } from './env';

/**
 * Session tokens — **edge-safe** (no node:crypto, no fs).
 *
 * Both `middleware.ts` (edge runtime) and the Node route handlers must be able
 * to verify a session, so the compact-JWT encoding lives here and is the only
 * module shared between the two runtimes.
 */

export const SESSION_COOKIE = 'zes_session';
export const CSRF_COOKIE = 'zes_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const THEME_COOKIE = 'zes_theme';

export const SESSION_AUDIENCE = 'zes-relay-panel';
export const SESSION_ISSUER = 'zes-relay-panel';

export interface SessionPayload {
  /** Username. */
  sub: string;
  role: 'admin';
  /** Session id — allows future revocation lists. */
  sid: string;
  iat: number;
  exp: number;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(
  username: string,
  secret: string,
  ttlHours: number,
  sessionId: string,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: 'admin', sid: sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(username)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + Math.floor(ttlHours * 3600))
    .sign(key(secret));
}

export async function verifySessionToken(
  token: string | undefined | null,
  secret: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      role: 'admin',
      sid: typeof payload.sid === 'string' ? payload.sid : '',
      iat: payload.iat ?? 0,
      exp: payload.exp ?? 0,
    };
  } catch {
    return null;
  }
}

/** Cookie attributes shared by the session and CSRF cookies. */
export function cookieOptions(options: {
  secure: boolean;
  maxAgeSeconds: number;
  httpOnly: boolean;
}): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
} {
  const sameSite = env.cookieSameSite;
  return {
    httpOnly: options.httpOnly,
    // SameSite=None is rejected by browsers unless the cookie is Secure.
    secure: sameSite === 'none' ? true : options.secure,
    sameSite,
    path: '/',
    maxAge: options.maxAgeSeconds,
  };
}

/** Base64url so the CSRF double-submit value never needs escaping. */
export function randomCsrfValue(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
