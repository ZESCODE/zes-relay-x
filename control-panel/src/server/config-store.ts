import { readFile, stat } from 'node:fs/promises';
import { chmodSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import type {
  ConfigDocument,
  ConfigFieldState,
  ConfigKey,
  ConfigValidationIssue,
  ConfigValidationResult,
} from '@/lib/types';
import { env } from './env';
import { ensureDataLayout, paths, readJsonFile, withLock } from './fs-paths';
import { redactText } from './redact';

/**
 * `data/.env` reader/writer for the four relay knobs.
 *
 * The file is the source of truth for the relay's runtime configuration and is
 * hand-editable: unknown keys, comments and blank lines are preserved verbatim
 * so the panel never reformats someone's file. Secrets are withheld from the
 * client unless the operator explicitly asks for them through the reveal
 * endpoint (which is audited in the panel log).
 */

export const MANAGED_KEYS: ConfigKey[] = [
  'POL_RELAY_PORT',
  'POL_UPSTREAM_BASE',
  'POL_API_KEY',
  'POL_SKIP_AUTH',
];

export const SECRET_KEYS: ConfigKey[] = ['POL_API_KEY'];

const KEY_COMMENTS: Record<ConfigKey, string[]> = {
  POL_RELAY_PORT: ['Port the relay listens on (loopback only).'],
  POL_UPSTREAM_BASE: ['OpenAI-compatible upstream the relay proxies to.'],
  POL_API_KEY: ['Key injected as "Authorization: Bearer …" unless POL_SKIP_AUTH=true.'],
  POL_SKIP_AUTH: ['true ⇒ forward the caller Authorization header instead of injecting a key.'],
};

export interface RelayConfigValues {
  POL_RELAY_PORT: string;
  POL_UPSTREAM_BASE: string;
  POL_API_KEY: string;
  POL_SKIP_AUTH: string;
}

export const DEFAULT_VALUES: RelayConfigValues = {
  POL_RELAY_PORT: '7179',
  POL_UPSTREAM_BASE: 'https://gen.pollinations.ai/v1',
  POL_API_KEY: '',
  POL_SKIP_AUTH: 'true',
};

type RunningValuesProvider = () => Partial<RelayConfigValues> | null;

let runningValuesProvider: RunningValuesProvider = () => null;

/** Registered by the bootstrap so the UI can diff saved vs. effective values. */
export function setRunningValuesProvider(provider: RunningValuesProvider): void {
  runningValuesProvider = provider;
}

interface ParsedEnv {
  lines: string[];
  values: Map<string, string>;
  comments: Map<string, string[]>;
  managedLineIndex: Map<string, number>;
}

function parseEnvText(text: string): ParsedEnv {
  const lines = text.split('\n');
  const values = new Map<string, string>();
  const comments = new Map<string, string[]>();
  const managedLineIndex = new Map<string, number>();
  let pendingComments: string[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') {
      pendingComments = [];
      return;
    }
    if (trimmed.startsWith('#')) {
      pendingComments.push(trimmed.replace(/^#\s?/, ''));
      return;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      pendingComments = [];
      return;
    }
    const key = match[1]!;
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
    if (pendingComments.length > 0) comments.set(key, [...pendingComments]);
    if ((MANAGED_KEYS as string[]).includes(key)) managedLineIndex.set(key, index);
    pendingComments = [];
  });

  return { lines, values, comments, managedLineIndex };
}

function serializeEnvValue(key: ConfigKey, value: string): string {
  if (key === 'POL_API_KEY' && value !== '') {
    // Quote secrets so special characters survive a round trip.
    return `${key}=${JSON.stringify(value)}`;
  }
  return `${key}=${value}`;
}

export class ConfigStore {
  async readValues(): Promise<RelayConfigValues> {
    const file = paths().envFile;
    if (!existsSync(file)) {
      // Fall back to the process environment, then to documented defaults.
      return {
        POL_RELAY_PORT: process.env.POL_RELAY_PORT ?? DEFAULT_VALUES.POL_RELAY_PORT,
        POL_UPSTREAM_BASE: process.env.POL_UPSTREAM_BASE ?? DEFAULT_VALUES.POL_UPSTREAM_BASE,
        POL_API_KEY: process.env.POL_API_KEY ?? DEFAULT_VALUES.POL_API_KEY,
        POL_SKIP_AUTH: process.env.POL_SKIP_AUTH ?? DEFAULT_VALUES.POL_SKIP_AUTH,
      };
    }
    const text = await readFile(file, 'utf8');
    const parsed = parseEnvText(text);
    return {
      POL_RELAY_PORT: parsed.values.get('POL_RELAY_PORT') ?? DEFAULT_VALUES.POL_RELAY_PORT,
      POL_UPSTREAM_BASE:
        parsed.values.get('POL_UPSTREAM_BASE') ?? DEFAULT_VALUES.POL_UPSTREAM_BASE,
      POL_API_KEY: parsed.values.get('POL_API_KEY') ?? DEFAULT_VALUES.POL_API_KEY,
      POL_SKIP_AUTH: parsed.values.get('POL_SKIP_AUTH') ?? DEFAULT_VALUES.POL_SKIP_AUTH,
    };
  }

  /** Masked view for the UI. */
  async load(): Promise<ConfigDocument> {
    ensureDataLayout();
    const file = paths().envFile;
    const exists = existsSync(file);
    const values = await this.readValues();
    const running = runningValuesProvider() ?? {};
    let passthrough = 0;

    if (exists) {
      const text = await readFile(file, 'utf8');
      const parsed = parseEnvText(text);
      passthrough = parsed.lines.filter((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) return false;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
        return Boolean(match) && !(MANAGED_KEYS as string[]).includes(match![1]!);
      }).length;
    }

    const fields: ConfigFieldState[] = MANAGED_KEYS.map((key) => {
      const isSecret = SECRET_KEYS.includes(key);
      const raw = values[key];
      const runningRaw = running[key];
      return {
        key,
        value: isSecret && raw !== '' ? '' : raw,
        masked: isSecret && raw !== '',
        runningValue: isSecret ? (runningRaw ? '***' : '') : (runningRaw ?? ''),
        isSecret,
        comment: KEY_COMMENTS[key],
      };
    });

    const dirtyKeys = MANAGED_KEYS.filter((key) => {
      const runningRaw = running[key];
      if (runningRaw === undefined) return false;
      return runningRaw !== values[key];
    });

    const updatedAt = exists ? await this.mtime(file) : null;

    return {
      path: file,
      exists,
      fields,
      passthrough,
      dirty: dirtyKeys,
      updatedAt,
    };
  }

  /** Raw values, including secrets (server-side callers only). */
  async loadRaw(): Promise<RelayConfigValues> {
    return this.readValues();
  }

  async reveal(key: ConfigKey): Promise<string> {
    if (!SECRET_KEYS.includes(key)) {
      const values = await this.readValues();
      return values[key];
    }
    const values = await this.readValues();
    return values[key];
  }

  /**
   * Persist managed keys. Values equal to `null`/`undefined` are left untouched
   * which lets the UI save a non-secret field without re-sending the key.
   */
  async save(values: Partial<RelayConfigValues>, options: { touchSecret?: boolean } = {}) {
    ensureDataLayout();
    const file = paths().envFile;
    return withLock(`config:${file}`, async () => {
      const existing = existsSync(file) ? await readFile(file, 'utf8') : '';
      const parsed = parseEnvText(existing);
      const next = new Map(parsed.values);

      for (const key of MANAGED_KEYS) {
        const raw = values[key];
        if (raw === undefined) continue;
        if (SECRET_KEYS.includes(key) && raw === '' && !options.touchSecret) continue;
        next.set(key, raw);
      }

      const lines = [...parsed.lines];
      const appended: string[] = [];

      for (const key of MANAGED_KEYS) {
        if (!next.has(key)) {
          if (values[key] === undefined) continue;
          next.set(key, values[key] as string);
        }
        const value = next.get(key) ?? '';
        const serialized = serializeEnvValue(key, value);
        const index = parsed.managedLineIndex.get(key);
        if (index === undefined) {
          appended.push(`${serialized}`);
          continue;
        }
        lines[index] = serialized;
      }

      let text = lines.join('\n');
      if (appended.length > 0) {
        const header =
          text.trim() === ''
            ? '# Managed by the ZES Relay Control Panel — hand edits are preserved.\n'
            : '\n# Added by the ZES Relay Control Panel\n';
        text = `${text}${header}${appended.join('\n')}\n`;
      }

      if (!text.endsWith('\n')) text += '\n';
      await writeJsonAtomicRaw(file, text, 0o600);

      const saved = await this.readValues();
      return { values: saved, path: file };
    });
  }

  /** Validate candidate values without writing them. */
  validate(
    candidate: Partial<RelayConfigValues>,
    current: RelayConfigValues,
  ): { issues: ConfigValidationIssue[]; normalized: Partial<Record<ConfigKey, string>> } {
    const issues: ConfigValidationIssue[] = [];
    const normalized: Partial<Record<ConfigKey, string>> = {};
    const merged: RelayConfigValues = { ...current, ...candidate };

    const portRaw = (candidate.POL_RELAY_PORT ?? current.POL_RELAY_PORT ?? '').trim();
    const port = Number.parseInt(portRaw, 10);
    if (!/^\d+$/.test(portRaw)) {
      issues.push({ key: 'POL_RELAY_PORT', level: 'error', message: 'Port must be an integer.' });
    } else if (port < 1 || port > 65535) {
      issues.push({ key: 'POL_RELAY_PORT', level: 'error', message: 'Port must be between 1 and 65535.' });
    } else {
      if (port < 1024) {
        issues.push({
          key: 'POL_RELAY_PORT',
          level: 'warning',
          message: 'Ports below 1024 usually require elevated privileges.',
        });
      }
      if (port === env.port && env.allowPublic === false) {
        issues.push({
          key: 'POL_RELAY_PORT',
          level: 'warning',
          message: `Port ${port} is used by the panel itself — pick another one.`,
        });
      }
      normalized.POL_RELAY_PORT = String(port);
    }

    const upstreamRaw = (candidate.POL_UPSTREAM_BASE ?? current.POL_UPSTREAM_BASE ?? '').trim();
    try {
      const url = new URL(upstreamRaw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        issues.push({
          key: 'POL_UPSTREAM_BASE',
          level: 'error',
          message: 'Upstream base must use the http:// or https:// scheme.',
        });
      } else if (!/\/v1\/?$/.test(url.pathname)) {
        issues.push({
          key: 'POL_UPSTREAM_BASE',
          level: 'warning',
          message: 'OpenAI-compatible bases normally end in /v1.',
        });
      }
      normalized.POL_UPSTREAM_BASE = upstreamRaw.replace(/\/$/, '');
    } catch {
      issues.push({ key: 'POL_UPSTREAM_BASE', level: 'error', message: 'Upstream base is not a valid URL.' });
    }

    const skipAuthRaw = (candidate.POL_SKIP_AUTH ?? current.POL_SKIP_AUTH ?? '').trim().toLowerCase();
    if (skipAuthRaw !== 'true' && skipAuthRaw !== 'false') {
      issues.push({ key: 'POL_SKIP_AUTH', level: 'error', message: 'POL_SKIP_AUTH must be "true" or "false".' });
    } else {
      normalized.POL_SKIP_AUTH = skipAuthRaw;
    }

    const apiKey =
      candidate.POL_API_KEY !== undefined ? candidate.POL_API_KEY : current.POL_API_KEY;
    if (apiKey) {
      if (/\s/.test(apiKey) && !apiKey.startsWith('"')) {
        issues.push({
          key: 'POL_API_KEY',
          level: 'warning',
          message: 'Key contains whitespace — it will be written quoted to data/.env.',
        });
      }
      normalized.POL_API_KEY = apiKey;
    }

    const effectiveSkipAuth = normalized.POL_SKIP_AUTH ?? merged.POL_SKIP_AUTH;
    if (effectiveSkipAuth === 'false' && !apiKey) {
      issues.push({
        key: 'POL_API_KEY',
        level: 'error',
        message: 'POL_SKIP_AUTH=false requires an API key, otherwise every upstream call is unauthenticated.',
      });
    }
    if (effectiveSkipAuth === 'true' && apiKey) {
      issues.push({
        key: 'POL_API_KEY',
        level: 'warning',
        message: 'A key is stored but POL_SKIP_AUTH=true — the relay forwards caller credentials instead.',
      });
    }

    return { issues, normalized };
  }

  private async mtime(file: string): Promise<string | null> {
    try {
      const stats = await stat(file);
      return stats.mtime.toISOString();
    } catch {
      return null;
    }
  }
}

/** Plain-text atomic write (shared by the config store and the importer). */
export async function writeJsonAtomicRaw(file: string, text: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      /* best effort */
    }
  }
  renameSync(tmp, file);
}

/* ── singleton ───────────────────────────────────────────────────────────── */

const GLOBAL_KEY = Symbol.for('zes.panel.config-store');

type GlobalWithConfig = typeof globalThis & { [GLOBAL_KEY]?: ConfigStore };

export function getConfigStore(): ConfigStore {
  const scope = globalThis as GlobalWithConfig;
  if (!scope[GLOBAL_KEY]) scope[GLOBAL_KEY] = new ConfigStore();
  return scope[GLOBAL_KEY] as ConfigStore;
}

export async function readPanelSettings<T>(fallback: T): Promise<T> {
  return readJsonFile<T>(paths().panelJson, fallback);
}

export function redactConfigForLog(values: Partial<RelayConfigValues>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = SECRET_KEYS.includes(key as ConfigKey) && value ? '***' : redactText(String(value));
  }
  return out;
}
