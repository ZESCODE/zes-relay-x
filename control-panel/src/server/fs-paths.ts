import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from './env';

/**
 * Deterministic filesystem layout.
 *
 * Everything the panel persists lives under a single data directory that is
 * created on first use with mode 0700:
 *
 *   data/
 *     .env                 relay configuration (edited by the config page)
 *     .session-secret      generated session signing key (0600)
 *     panel.json           admin credentials + panel preferences
 *     tokens.json          API tokens for scripts/CI
 *     metrics.json         counter snapshot (restored on boot)
 *     events.jsonl         relay lifecycle events
 *     presets/<id>.json    playground presets
 *     backups/<id>.zip     data backups
 *     logs/panel.jsonl     structured panel log (rotating)
 */

export const DATA_DIR_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;

function hasPanelMarkers(dir: string): boolean {
  return existsSync(path.join(dir, 'next.config.mjs')) || existsSync(path.join(dir, 'package.json'));
}

/** Directory that contains the panel app (next.config.mjs / package.json). */
export function panelRoot(): string {
  const cwd = process.cwd();
  if (hasPanelMarkers(cwd)) return cwd;
  const nested = path.join(cwd, 'control-panel');
  if (hasPanelMarkers(nested)) return nested;
  return cwd;
}

/**
 * Repository root — the directory that also holds pol_relay.py. Falls back to
 * the parent of the panel when the marker cannot be found (standalone deploy).
 */
export function repoRoot(): string {
  const root = panelRoot();
  const candidates = [root, path.dirname(root), path.dirname(path.dirname(root))];
  for (const candidate of candidates) {
    if (
      existsSync(path.join(candidate, 'pol_relay.py')) ||
      existsSync(path.join(candidate, 'pol-relay.py'))
    ) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, '.git'))) return candidate;
  }
  return path.dirname(root);
}

export function dataDir(): string {
  const configured = env.dataDir;
  if (configured) return path.resolve(configured);
  const root = repoRoot();
  return path.join(root, 'data');
}

export function paths() {
  const dir = dataDir();
  return {
    dataDir: dir,
    envFile: path.join(dir, '.env'),
    sessionSecretFile: path.join(dir, '.session-secret'),
    panelJson: path.join(dir, 'panel.json'),
    tokensJson: path.join(dir, 'tokens.json'),
    metricsJson: path.join(dir, 'metrics.json'),
    eventsJsonl: path.join(dir, 'events.jsonl'),
    presetsDir: path.join(dir, 'presets'),
    backupsDir: path.join(dir, 'backups'),
    logsDir: path.join(dir, 'logs'),
    panelLog: path.join(dir, 'logs', 'panel.jsonl'),
  } as const;
}

/** Create a directory (recursively) and tighten permissions. */
export function ensureDir(dir: string, mode = DATA_DIR_MODE): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode });
  }
  try {
    chmodSync(dir, mode);
  } catch {
    // Filesystems without POSIX modes (e.g. some bind mounts) — best effort.
  }
  return dir;
}

export function ensureDataLayout(): ReturnType<typeof paths> {
  const layout = paths();
  ensureDir(layout.dataDir);
  ensureDir(layout.presetsDir);
  ensureDir(layout.backupsDir);
  ensureDir(layout.logsDir);
  return layout;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Serialised mutation — a single writer per file, in-process.
 * ──────────────────────────────────────────────────────────────────────────── */

const locks = new Map<string, Promise<unknown>>();

/** Run `task` with exclusive access to `key` (per process, FIFO ordering). */
export function withLock<T>(key: string, task: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  // Keep the chain alive but never reject the stored promise.
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run as Promise<T>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * JSON helpers
 * ──────────────────────────────────────────────────────────────────────────── */

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8');
    if (raw.trim() === '') return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readJsonFileSync<T>(file: string, fallback: T): T {
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw.trim() === '') return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: serialise → temp file → rename. Never leaves partial JSON. */
export async function writeJsonAtomic(file: string, value: unknown, mode?: number): Promise<void> {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, payload, mode === undefined ? undefined : { mode });
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      /* best effort */
    }
  }
  renameSync(tmp, file);
}

export function writeJsonAtomicSync(file: string, value: unknown, mode?: number): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(tmp, payload, mode === undefined ? undefined : { mode });
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      /* best effort */
    }
  }
  renameSync(tmp, file);
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  ensureDir(path.dirname(file));
  await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function appendJsonlSync(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'a' });
}

export async function readJsonlTail(file: string, limit: number): Promise<unknown[]> {
  try {
    const raw = await readFile(file, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    const out: unknown[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Rotate `file` to `file.1`, shifting older generations up to `keep`. */
export function rotateFileIfNeeded(file: string, maxBytes: number, keep: number): boolean {
  try {
    const stats = statSync(file);
    if (stats.size < maxBytes) return false;
  } catch {
    return false;
  }
  try {
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      const to = `${file}.${index + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(file, `${file}.1`);
    if (keep === 0) {
      // Rotation disabled — truncate instead of keeping generations.
      writeFileSync(file, '');
    }
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Binary helpers
 * ──────────────────────────────────────────────────────────────────────────── */

export async function fileSize(file: string): Promise<number> {
  try {
    const stats = await statSafe(file);
    return stats?.size ?? 0;
  } catch {
    return 0;
  }
}

async function statSafe(file: string) {
  try {
    const { stat } = await import('node:fs/promises');
    return await stat(file);
  } catch {
    return null;
  }
}

export function sha256FileSync(file: string): string | null {
  try {
    const buffer = readFileSync(file);
    return createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null;
  }
}

export async function sha256File(file: string): Promise<string | null> {
  try {
    const buffer = await readFile(file);
    return createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null;
  }
}

/** Recursively sum the size of a directory (best effort). */
export function directorySizeSync(dir: string, depth = 0): number {
  if (depth > 6) return 0;
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const stats = statSync(full);
      if (stats.isDirectory()) total += directorySizeSync(full, depth + 1);
      else total += stats.size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

export function resolveFromPanel(relativeOrAbsolute: string): string {
  if (path.isAbsolute(relativeOrAbsolute)) return relativeOrAbsolute;
  return path.resolve(panelRoot(), relativeOrAbsolute);
}

export function toRelativePanelPath(absolute: string): string {
  const relative = path.relative(panelRoot(), absolute);
  return relative.startsWith('..') ? absolute : relative;
}
