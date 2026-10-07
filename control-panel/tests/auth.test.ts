import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  changePassword,
  createSessionCookieValue,
  ensureAdmin,
  findUser,
  hashPassword,
  getSessionSecret,
  resetAuthCache,
  verifyPassword,
} from '@/server/auth';
import { verifySessionToken, createSessionToken } from '@/server/session-token';

/**
 * Auth tests: scrypt hashing, constant-time verification, JWT session
 * lifecycle, first-run admin creation and password rotation.
 *
 * Every test runs against a throw-away PANEL_DATA_DIR so nothing touches the
 * developer's real `data/` directory.
 */

const originalDataDir = process.env.PANEL_DATA_DIR;
const createdDirs: string[] = [];

/** Fresh data dir per test so state never leaks between cases. */
async function freshDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zes-auth-'));
  createdDirs.push(dir);
  process.env.PANEL_DATA_DIR = dir;
  resetAuthCache();
  return dir;
}

describe('password hashing', () => {
  it('produces a scrypt record and verifies it', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[1]).toBe('16384');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('salts every hash independently', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');
    expect(first).not.toBe(second);
    expect(await verifyPassword('same-password', first)).toBe(true);
    expect(await verifyPassword('same-password', second)).toBe(true);
  });

  it('rejects malformed records instead of throwing', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$2$3$zz$zz')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});

describe('session tokens', () => {
  it('signs and verifies a session', async () => {
    const token = await createSessionToken('admin', 'test-secret-value', 1, 'session-1');
    const payload = await verifySessionToken(token, 'test-secret-value');
    expect(payload?.sub).toBe('admin');
    expect(payload?.role).toBe('admin');
    expect(payload?.sid).toBe('session-1');
    expect(payload?.exp).toBeGreaterThan(payload?.iat ?? 0);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await createSessionToken('admin', 'secret-a', 1, 'sid');
    expect(await verifySessionToken(token, 'secret-b')).toBeNull();
  });

  it('rejects tampered and malformed tokens', async () => {
    const token = await createSessionToken('admin', 'secret', 1, 'sid');
    const [header, payload, signature] = token.split('.');
    expect(await verifySessionToken(`${header}.${payload}.${signature}x`, 'secret')).toBeNull();
    expect(await verifySessionToken('not.a.jwt', 'secret')).toBeNull();
    expect(await verifySessionToken(undefined, 'secret')).toBeNull();
    expect(await verifySessionToken(token, undefined)).toBeNull();
  });

  it('expires short-lived sessions', async () => {
    const token = await createSessionToken('admin', 'secret', 0.00001, 'sid');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await verifySessionToken(token, 'secret')).toBeNull();
  });
});

describe('first-run admin', () => {
  it('creates an admin and accepts the generated password', async () => {
    await freshDataDir();
    delete process.env.PANEL_ADMIN_PASSWORD;
    const result = await ensureAdmin();
    expect(result.created).toBe(true);
    expect(result.generatedPassword).toBeTruthy();

    const user = await findUser('admin');
    expect(user).not.toBeNull();
    expect(user?.mustChangePassword).toBe(true);
    expect(await verifyPassword(result.generatedPassword as string, user!.passwordHash)).toBe(true);

    // A second call must not mint another account.
    const again = await ensureAdmin();
    expect(again.created).toBe(false);
  });

  it('honours PANEL_ADMIN_PASSWORD and does not force a rotation', async () => {
    await freshDataDir();
    process.env.PANEL_ADMIN_PASSWORD = 'from-environment-123';
    try {
      const result = await ensureAdmin();
      expect(result.created).toBe(true);
      expect(result.generatedPassword).toBeNull();
      const user = await findUser('admin');
      expect(user?.mustChangePassword).toBe(false);
      expect(await verifyPassword('from-environment-123', user!.passwordHash)).toBe(true);
    } finally {
      delete process.env.PANEL_ADMIN_PASSWORD;
    }
  });

  it('rotates the stored password when the env password changes', async () => {
    await freshDataDir();
    process.env.PANEL_ADMIN_PASSWORD = 'first-password-value';
    await ensureAdmin();
    process.env.PANEL_ADMIN_PASSWORD = 'second-password-value';
    await ensureAdmin();
    const user = await findUser('admin');
    expect(await verifyPassword('second-password-value', user!.passwordHash)).toBe(true);
    expect(await verifyPassword('first-password-value', user!.passwordHash)).toBe(false);
    delete process.env.PANEL_ADMIN_PASSWORD;
  });

  it('changes a password only with the correct current one', async () => {
    await freshDataDir();
    process.env.PANEL_ADMIN_PASSWORD = 'current-password-1';
    await ensureAdmin();
    delete process.env.PANEL_ADMIN_PASSWORD;

    await expect(changePassword('admin', 'wrong', 'next-password-1')).rejects.toThrow(/incorrect/i);
    await expect(changePassword('admin', 'current-password-1', 'short')).rejects.toThrow(/10 characters/i);

    await changePassword('admin', 'current-password-1', 'next-password-1');
    const user = await findUser('admin');
    expect(user?.mustChangePassword).toBe(false);
    expect(await verifyPassword('next-password-1', user!.passwordHash)).toBe(true);
  });
});

describe('session secret + cookie minting', () => {
  it('generates a secret file once and reuses it', async () => {
    const dir = await freshDataDir();
    delete process.env.PANEL_SESSION_SECRET;
    const first = await getSessionSecret();
    expect(first.length).toBeGreaterThan(30);
    const file = path.join(dir, '.session-secret');
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(file, 'utf8')) as { secret: string };
    expect(raw.secret).toBe(first);
  });

  it('mints a cookie value that verifies against the same secret', async () => {
    await freshDataDir();
    delete process.env.PANEL_SESSION_SECRET;
    const cookie = await createSessionCookieValue('admin');
    const secret = await getSessionSecret();
    const payload = await verifySessionToken(cookie, secret);
    expect(payload?.sub).toBe('admin');
  });
});

describe('redaction', () => {
  it('never leaks bearer tokens or provider keys', async () => {
    const { redactText, maskSecret } = await import('@/server/redact');
    expect(redactText('Authorization: Bearer sk-abcdef1234567890')).not.toContain('sk-abcdef1234567890');
    expect(redactText('{"api_key":"super-secret-value"}')).not.toContain('super-secret-value');
    expect(redactText('POL_API_KEY=sk-live-0123456789abcdef')).not.toContain('sk-live-0123456789abcdef');
    // The masked form keeps only a short, non-reversible prefix.
    expect(maskSecret('zes_abcdefghijklmnop')).toBe('zes_…mnop');
    expect(maskSecret('short')).not.toContain('short');
  });
});

afterEach(async () => {
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (originalDataDir === undefined) delete process.env.PANEL_DATA_DIR;
  else process.env.PANEL_DATA_DIR = originalDataDir;
  resetAuthCache();
});
