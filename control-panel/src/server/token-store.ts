import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ApiToken, ApiTokenWithSecret, TokenScope } from '@/lib/types';
import { ensureDataLayout, paths, readJsonFile, withLock, writeJsonAtomic } from './fs-paths';
import { getLogBus } from './log-bus';
import { maskSecret } from './redact';

/**
 * API tokens for scripts and CI (`Authorization: Bearer zes_…`).
 *
 * Storage: `data/tokens.json` (mode 0600). Only a SHA-256 hash of the secret is
 * persisted; the plaintext is returned exactly once at creation. Verification is
 * a prefix lookup followed by a constant-time comparison, and `lastUsedAt` is
 * refreshed at most once per minute to avoid write amplification.
 */

const TOKEN_PREFIX = 'zes_';
const LOOKUP_PREFIX_LENGTH = 8;
const LAST_USED_THROTTLE_MS = 60_000;

interface StoredToken extends ApiToken {
  hash: string;
}

interface TokensFile {
  version: number;
  tokens: StoredToken[];
  updatedAt: string;
}

function emptyFile(): TokensFile {
  return { version: 1, tokens: [], updatedAt: new Date().toISOString() };
}

function hashed(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function publicView(token: StoredToken): ApiToken {
  const { hash: _hash, ...rest } = token;
  void _hash;
  return rest;
}

export class TokenStore {
  private cache: TokensFile | null = null;

  private async load(): Promise<TokensFile> {
    if (this.cache) return this.cache;
    ensureDataLayout();
    const file = await readJsonFile<TokensFile | null>(paths().tokensJson, null);
    this.cache = file && Array.isArray(file.tokens) ? file : emptyFile();
    return this.cache;
  }

  private async persist(): Promise<void> {
    if (!this.cache) return;
    this.cache.updatedAt = new Date().toISOString();
    await writeJsonAtomic(paths().tokensJson, this.cache, 0o600);
  }

  async list(): Promise<ApiToken[]> {
    const file = await this.load();
    return file.tokens
      .map(publicView)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async create(input: {
    name: string;
    scopes: TokenScope[];
    expiresInDays?: number | null;
  }): Promise<ApiTokenWithSecret> {
    const name = input.name.trim();
    if (name.length < 2) {
      throw new Error('Token name must be at least 2 characters long.');
    }
    const scopes = input.scopes.length > 0 ? input.scopes : (['read'] as TokenScope[]);
    return withLock('tokens', async () => {
      const file = await this.load();
      const secret = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
      const now = new Date().toISOString();
      const expiresAt =
        input.expiresInDays && input.expiresInDays > 0
          ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
          : null;
      const stored: StoredToken = {
        id: randomUUID(),
        name,
        prefix: secret.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + LOOKUP_PREFIX_LENGTH),
        scopes,
        createdAt: now,
        lastUsedAt: null,
        expiresAt,
        revokedAt: null,
        hash: hashed(secret),
      };
      file.tokens.push(stored);
      await this.persist();
      getLogBus().push({
        source: 'system',
        level: 'info',
        message: `Created API token "${name}" (${secret.slice(0, 12)}…, scopes: ${scopes.join(',')}).`,
      });
      return { token: publicView(stored), secret };
    });
  }

  async revoke(id: string): Promise<ApiToken> {
    return withLock('tokens', async () => {
      const file = await this.load();
      const token = file.tokens.find((item) => item.id === id);
      if (!token) throw new Error(`Unknown token ${id}`);
      token.revokedAt = new Date().toISOString();
      await this.persist();
      getLogBus().push({
        source: 'system',
        level: 'warn',
        message: `Revoked API token "${token.name}" (${token.prefix}…).`,
      });
      return publicView(token);
    });
  }

  async delete(id: string): Promise<boolean> {
    return withLock('tokens', async () => {
      const file = await this.load();
      const before = file.tokens.length;
      file.tokens = file.tokens.filter((item) => item.id !== id);
      if (file.tokens.length === before) return false;
      await this.persist();
      return true;
    });
  }

  /** Resolve a bearer secret. Returns null for revoked/expired/unknown tokens. */
  async verify(secret: string): Promise<ApiToken | null> {
    if (!secret.startsWith(TOKEN_PREFIX)) return null;
    const prefix = secret.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + LOOKUP_PREFIX_LENGTH);
    const file = await this.load();
    const digest = hashed(secret);
    const candidates = file.tokens.filter((token) => token.prefix === prefix);
    for (const token of candidates) {
      const storedBuffer = Buffer.from(token.hash, 'hex');
      const providedBuffer = Buffer.from(digest, 'hex');
      if (storedBuffer.length !== providedBuffer.length) continue;
      if (!timingSafeEqual(storedBuffer, providedBuffer)) continue;
      if (token.revokedAt) return null;
      if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) return null;
      await this.touch(token);
      return publicView(token);
    }
    return null;
  }

  private async touch(token: StoredToken): Promise<void> {
    const last = token.lastUsedAt ? new Date(token.lastUsedAt).getTime() : 0;
    if (Date.now() - last < LAST_USED_THROTTLE_MS) return;
    token.lastUsedAt = new Date().toISOString();
    await withLock('tokens', async () => this.persist());
  }

  /** Redacted description safe for logs. */
  static describe(token: ApiToken): string {
    return `${token.name} (${token.prefix}…, scopes ${token.scopes.join(',')}${
      token.expiresAt ? `, expires ${token.expiresAt}` : ''
    })`;
  }

  static mask(secret: string): string {
    return maskSecret(secret, 8, 4);
  }
}

const GLOBAL_KEY = Symbol.for('zes.panel.token-store');

type GlobalWithTokens = typeof globalThis & { [GLOBAL_KEY]?: TokenStore };

export function getTokenStore(): TokenStore {
  const scope = globalThis as GlobalWithTokens;
  if (!scope[GLOBAL_KEY]) scope[GLOBAL_KEY] = new TokenStore();
  return scope[GLOBAL_KEY] as TokenStore;
}

export function resetTokenStore(): void {
  const scope = globalThis as GlobalWithTokens;
  delete scope[GLOBAL_KEY];
}
