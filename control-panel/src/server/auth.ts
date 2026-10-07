import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  type BinaryLike,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import type { SessionUser, ThemeName } from '@/lib/types';
import { env } from './env';
import {
  ensureDataLayout,
  readJsonFile,
  paths,
  withLock,
  writeJsonAtomic,
} from './fs-paths';
import { getLogBus } from './log-bus';
import { maskSecret } from './redact';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  THEME_COOKIE,
  cookieOptions,
  randomCsrfValue,
  verifySessionToken,
  type SessionPayload,
} from './session-token';
import { getTokenStore } from './token-store';
import { ApiHttpError } from './http';

/**
 * promisify() cannot infer the options overload of crypto.scrypt, so the
 * promise-returning shape is declared explicitly here.
 */
const scrypt = promisify(scryptCallback) as unknown as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Authentication & authorisation (Node runtime only).
 *
 * • Passwords: scrypt (N=16384, r=8, p=1, 64-byte key) with a per-user salt,
 *   verified in constant time.
 * • Sessions: HS256 JWT in an httpOnly, SameSite=Lax, Secure-in-prod cookie.
 * • Scripts/CI: `Authorization: Bearer <panel token>` handled by token-store.
 * • CSRF: double-submit cookie + Origin/Host check for state-changing verbs.
 */

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export interface PanelUserRecord {
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  mustChangePassword: boolean;
  theme: ThemeName;
}

export interface PanelSettingsFile {
  version: number;
  users: PanelUserRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface AuthContext {
  user: SessionUser;
  via: 'session' | 'token';
  tokenName?: string;
  scopes: string[];
}

/* ── password hashing ─────────────────────────────────────────────────────── */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = (await scrypt(password, salt, expected.length, { N, r, p })) as Buffer;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/* ── settings file ────────────────────────────────────────────────────────── */

function emptySettings(): PanelSettingsFile {
  const now = new Date().toISOString();
  return { version: 1, users: [], createdAt: now, updatedAt: now };
}

export async function readPanelSettings(): Promise<PanelSettingsFile> {
  const stored = await readJsonFile<PanelSettingsFile | null>(paths().panelJson, null);
  if (!stored || !Array.isArray(stored.users)) return emptySettings();
  return stored;
}

async function writePanelSettings(settings: PanelSettingsFile): Promise<void> {
  settings.updatedAt = new Date().toISOString();
  await writeJsonAtomic(paths().panelJson, settings, 0o600);
}

function toSessionUser(record: PanelUserRecord): SessionUser {
  return {
    username: record.username,
    role: 'admin',
    createdAt: record.createdAt,
    mustChangePassword: record.mustChangePassword,
  };
}

/**
 * First run: create the admin account.
 *
 * The password comes from PANEL_ADMIN_PASSWORD, otherwise a random one-time
 * password is generated and printed **once** to the panel log.
 */
export async function ensureAdmin(): Promise<{ created: boolean; generatedPassword: string | null }> {
  ensureDataLayout();
  return withLock('panel-settings', async () => {
    const settings = await readPanelSettings();
    const configuredUser = env.adminUser;

    if (settings.users.length > 0) {
      const existing = settings.users[0]!;
      const envPassword = env.adminPassword;
      // PANEL_ADMIN_PASSWORD lets an operator rotate the bootstrap credential.
      if (envPassword && !(await verifyPassword(envPassword, existing.passwordHash))) {
        existing.passwordHash = await hashPassword(envPassword);
        existing.updatedAt = new Date().toISOString();
        existing.mustChangePassword = false;
        settings.users = [existing, ...settings.users.slice(1)];
        await writePanelSettings(settings);
        getLogBus().push({
          source: 'system',
          level: 'warn',
          message:
            'Admin password rotated from PANEL_ADMIN_PASSWORD. Remove the variable once you have changed it in the UI.',
        });
        return { created: false, generatedPassword: null };
      }
      return { created: false, generatedPassword: null };
    }

    const password = env.adminPassword ?? generatePassword();
    const now = new Date().toISOString();
    const record: PanelUserRecord = {
      username: configuredUser,
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
      mustChangePassword: env.adminPassword === null,
      theme: 'dark',
    };
    settings.users = [record];
    await writePanelSettings(settings);

    getLogBus().push({
      source: 'system',
      level: 'warn',
      message: `Created the panel admin account "${record.username}".`,
    });
    if (env.adminPassword === null) {
      getLogBus().push({
        source: 'system',
        level: 'warn',
        message:
          '════════ ONE-TIME ADMIN PASSWORD ════════\n' +
          `  username: ${record.username}\n` +
          `  password: ${password}\n` +
          '  Shown once — change it in Admin → Account right after signing in.\n' +
          '══════════════════════════════════════════',
      });
    }
    return { created: true, generatedPassword: env.adminPassword === null ? password : null };
  });
}

export function generatePassword(length = 20): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_=+';
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[bytes[index]! % alphabet.length];
  }
  return out;
}

export async function findUser(username: string): Promise<PanelUserRecord | null> {
  const settings = await readPanelSettings();
  return settings.users.find((user) => user.username === username) ?? null;
}

export async function setTheme(theme: ThemeName, username?: string): Promise<void> {
  await withLock('panel-settings', async () => {
    const settings = await readPanelSettings();
    const target = username
      ? settings.users.find((user) => user.username === username)
      : settings.users[0];
    if (!target) return;
    target.theme = theme;
    target.updatedAt = new Date().toISOString();
    await writePanelSettings(settings);
  });
}

export async function changePassword(
  username: string,
  currentPassword: string,
  nextPassword: string,
): Promise<void> {
  if (nextPassword.length < 10) {
    throw new ApiHttpError(
      'validation_failed',
      'New password must be at least 10 characters long.',
      400,
    );
  }
  await withLock('panel-settings', async () => {
    const settings = await readPanelSettings();
    const target = settings.users.find((user) => user.username === username);
    if (!target) throw new ApiHttpError('not_found', 'Unknown user.', 404);
    if (!(await verifyPassword(currentPassword, target.passwordHash))) {
      throw new ApiHttpError('forbidden', 'Current password is incorrect.', 403);
    }
    target.passwordHash = await hashPassword(nextPassword);
    target.mustChangePassword = false;
    target.updatedAt = new Date().toISOString();
    await writePanelSettings(settings);
    getLogBus().push({
      source: 'system',
      level: 'warn',
      message: `Password changed for "${username}" (hash ${maskSecret(target.passwordHash, 12, 6)}).`,
    });
  });
}

/* ── session secret ───────────────────────────────────────────────────────── */

let cachedSecret: string | null = null;

/** Test helper: forget the cached secret (used when switching data dirs). */
export function resetAuthCache(): void {
  cachedSecret = null;
}

export async function getSessionSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const fromEnv = env.sessionSecret;
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  const file = paths().sessionSecretFile;
  const existing = await readJsonFile<{ secret?: string } | null>(file, null);
  if (existing?.secret && existing.secret.length >= 32) {
    cachedSecret = existing.secret;
    return cachedSecret;
  }
  const generated = randomBytes(48).toString('base64url');
  await writeJsonAtomic(file, { secret: generated, createdAt: new Date().toISOString() }, 0o600);
  getLogBus().push({
    source: 'system',
    level: 'info',
    message: `Generated a session signing secret at ${file} (mode 0600). Set PANEL_SESSION_SECRET to keep sessions across data-dir moves.`,
  });
  cachedSecret = generated;
  return cachedSecret;
}

export async function createSessionCookieValue(username: string): Promise<string> {
  const { createSessionToken } = await import('./session-token');
  const secret = await getSessionSecret();
  return createSessionToken(username, secret, env.sessionTtlHours, randomUUID());
}

export async function readSession(req: Request | NextRequest): Promise<SessionPayload | null> {
  const cookieHeader = req.headers.get('cookie') ?? '';
  const token = readCookieFromHeader(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const secret = await getSessionSecret();
  return verifySessionToken(token, secret);
}

export function readCookieFromHeader(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const target = `${name}=`;
    if (trimmed.startsWith(target)) return decodeURIComponent(trimmed.slice(target.length));
  }
  return null;
}

/** Session length in seconds, used for cookie maxAge. */
export function sessionMaxAgeSeconds(): number {
  return Math.floor(env.sessionTtlHours * 3600);
}

export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]!.trim() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return env.allowPublic && process.env.NODE_ENV === 'production';
  }
}

/* ── request authentication ───────────────────────────────────────────────── */

export async function authenticate(req: Request | NextRequest): Promise<AuthContext | null> {
  const session = await readSession(req);
  if (session) {
    const record = await findUser(session.sub);
    if (record) {
      return { user: toSessionUser(record), via: 'session', scopes: ['read', 'write', 'admin'] };
    }
  }

  const header = req.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    const secret = header.slice(7).trim();
    const token = await getTokenStore().verify(secret);
    if (token) {
      return {
        user: {
          username: `token:${token.name}`,
          role: 'admin',
          createdAt: token.createdAt,
          mustChangePassword: false,
        },
        via: 'token',
        tokenName: token.name,
        scopes: token.scopes,
      };
    }
  }
  return null;
}

/** Throws 401 unless the request is authenticated. */
export async function requireAuth(req: Request | NextRequest): Promise<AuthContext> {
  const context = await authenticate(req);
  if (!context) {
    throw new ApiHttpError('unauthorized', 'Authentication required.', 401);
  }
  return context;
}

export function requireScope(context: AuthContext, scope: 'read' | 'write' | 'admin'): void {
  if (context.via === 'session') return;
  const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
  const allowed = context.scopes.some((item) => (rank[item] ?? 0) >= (rank[scope] ?? 99));
  if (!allowed) {
    throw new ApiHttpError('forbidden', `This API token lacks the "${scope}" scope.`, 403);
  }
}

/* ── CSRF ─────────────────────────────────────────────────────────────────── */

export function issueCsrfCookie(): string {
  return randomCsrfValue();
}

/** Origin/Host check — protects mutations even before the double submit. */
export function assertSameOrigin(req: Request | NextRequest): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const origin = req.headers.get('origin');
  if (!origin) return; // non-browser clients (curl, CI) send no Origin
  const host = req.headers.get('host');
  if (!host) return;
  // Behind a trusted proxy the browser-visible host arrives in
  // X-Forwarded-Host while Host carries the internal address.
  const allowed = new Set<string>([host]);
  if (env.trustProxy) {
    for (const part of (req.headers.get('x-forwarded-host') ?? '').split(',')) {
      const trimmed = part.trim();
      if (trimmed) allowed.add(trimmed);
    }
  }
  try {
    const originUrl = new URL(origin);
    if (!allowed.has(originUrl.host)) {
      throw new ApiHttpError(
        'forbidden',
        `Cross-origin request blocked (origin ${originUrl.host} ≠ host ${host}).`,
        403,
      );
    }
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    throw new ApiHttpError('forbidden', 'Malformed Origin header.', 403);
  }
}

/** Double-submit cookie check for cookie-authenticated mutations. */
export function assertCsrf(req: Request | NextRequest, context: AuthContext): void {
  if (context.via === 'token') return; // Bearer tokens are not ambient credentials
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieValue = readCookieFromHeader(cookieHeader, CSRF_COOKIE);
  const headerValue = req.headers.get(CSRF_HEADER);
  if (!cookieValue || !headerValue) {
    throw new ApiHttpError(
      'forbidden',
      'Missing CSRF token. Reload the panel and try again.',
      403,
    );
  }
  if (!constantTimeEquals(cookieValue, headerValue)) {
    throw new ApiHttpError('forbidden', 'CSRF token mismatch.', 403);
  }
}

/* ── route guard ──────────────────────────────────────────────────────────── */

export interface GuardOptions {
  scope?: 'read' | 'write' | 'admin';
  rateLimit?: 'login' | 'chat' | 'admin';
}

/**
 * The single entry point every state-changing route uses: origin check →
 * authentication → scope → CSRF double submit → rate limit.
 */
export async function guard(req: Request | NextRequest, options: GuardOptions = {}): Promise<AuthContext> {
  assertSameOrigin(req);
  const context = await requireAuth(req);
  if (options.scope) requireScope(context, options.scope);
  assertCsrf(req, context);
  if (options.rateLimit) {
    const { enforceRateLimit } = await import('./rate-limit');
    const { clientIp } = await import('./http');
    enforceRateLimit(options.rateLimit, `${context.user.username}:${clientIp(req)}`);
  }
  return context;
}

/* ── server-component helpers ─────────────────────────────────────────────── */

/** Reads the theme from the request cookies (no FOUC — applied server-side). */
export function themeFromCookies(fallback: ThemeName = 'dark'): ThemeName {
  try {
    const store = cookies();
    const value = store.get(THEME_COOKIE)?.value;
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // Not in a request scope (e.g. tests) — fall back to the stored preference.
  }
  return fallback === 'light' ? 'light' : 'dark';
}

export function csrfFromCookies(): string | null {
  try {
    return cookies().get(CSRF_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function themeCookieName(): string {
  return THEME_COOKIE;
}

export function csrfCookieName(): string {
  return CSRF_COOKIE;
}

export { cookieOptions };
