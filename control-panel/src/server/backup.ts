import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BackupEntry } from '@/lib/types';
import { env } from './env';
import { ensureDataLayout, paths, withLock } from './fs-paths';
import { getLogBus } from './log-bus';
import { ApiHttpError } from './http';
import { createZip, type ZipEntry } from './zip';

/**
 * Backups: `data/` is zipped into `data/backups/<timestamp>-<id>.zip`.
 *
 * Secrets are excluded unless explicitly requested (`includeSecrets`):
 *   • `.session-secret` is always skipped
 *   • `POL_API_KEY` is stripped from the archived `.env`
 *   • the admin password hash is stripped from `panel.json`
 * The archive records what it contains so the UI can label it honestly.
 */

const ID_PATTERN = /^[a-z0-9-]{4,80}$/;

export interface BackupFilePayload {
  name: string;
  /** Bytes of the resulting archive. */
  bytes: number;
  files: number;
}

export class BackupService {
  async create(options: { includeSecrets?: boolean } = {}): Promise<BackupEntry> {
    const includeSecrets = options.includeSecrets === true;
    ensureDataLayout();
    const dataDir = paths().dataDir;
    const backupsDir = paths().backupsDir;
    const files = await this.collect(dataDir, backupsDir);

    const entries: ZipEntry[] = [];
    for (const file of files) {
      const relative = path.relative(dataDir, file).split(path.sep).join('/');
      const contents = await this.readForArchive(file, relative, includeSecrets);
      if (contents === null) continue;
      entries.push({ path: relative, data: contents, store: relative.endsWith('.zip') });
    }

    entries.push({
      path: 'BACKUP-README.txt',
      data: [
        'ZES Relay Control Panel backup',
        `created: ${new Date().toISOString()}`,
        `secrets included: ${includeSecrets ? 'yes' : 'no'}`,
        '',
        includeSecrets
          ? 'This archive contains credentials — store it accordingly.'
          : 'Secrets were excluded: POL_API_KEY, .session-secret and the admin password hash.',
        '',
      ].join('\n'),
    });

    const archive = createZip(entries);
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const target = path.join(backupsDir, `${id}.zip`);

    await withLock('backups', async () => {
      await writeFile(target, archive, { mode: 0o600 });
    });

    const entry: BackupEntry = {
      id,
      name: `${id}.zip`,
      createdAt: new Date().toISOString(),
      bytes: archive.length,
      files: entries.length,
      containsSecrets: includeSecrets,
    };

    getLogBus().push({
      source: 'system',
      level: 'info',
      message: `Created backup ${entry.name} (${entries.length} files, ${archive.length} bytes, secrets: ${
        includeSecrets ? 'included' : 'excluded'
      }).`,
    });

    await this.prune();
    return entry;
  }

  async list(): Promise<{ backups: BackupEntry[]; totalBytes: number }> {
    ensureDataLayout();
    const dir = paths().backupsDir;
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.zip'));
    } catch {
      return { backups: [], totalBytes: 0 };
    }

    const backups: BackupEntry[] = [];
    let totalBytes = 0;
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const stats = await stat(full);
        const id = name.replace(/\.zip$/, '');
        backups.push({
          id,
          name,
          createdAt: stats.mtime.toISOString(),
          bytes: stats.size,
          files: await countZipEntries(full),
          containsSecrets: await zipContainsSecrets(full),
        });
        totalBytes += stats.size;
      } catch {
        /* skip unreadable file */
      }
    }

    backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { backups, totalBytes };
  }

  async resolvePath(id: string): Promise<string> {
    if (!ID_PATTERN.test(id)) {
      throw new ApiHttpError('validation_failed', 'Invalid backup id.', 422);
    }
    const file = path.join(paths().backupsDir, id.endsWith('.zip') ? id : `${id}.zip`);
    try {
      const stats = await stat(file);
      if (!stats.isFile()) throw new Error('not a file');
      return file;
    } catch {
      throw new ApiHttpError('not_found', `Backup ${id} does not exist.`, 404);
    }
  }

  async delete(id: string): Promise<boolean> {
    const file = await this.resolvePath(id);
    await unlink(file);
    getLogBus().push({ source: 'system', level: 'warn', message: `Deleted backup ${path.basename(file)}.` });
    return true;
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  private async prune(): Promise<void> {
    const { backups } = await this.list();
    if (backups.length <= env.maxBackups) return;
    for (const backup of backups.slice(env.maxBackups)) {
      try {
        await unlink(path.join(paths().backupsDir, backup.name));
        getLogBus().push({
          source: 'system',
          level: 'info',
          message: `Pruned old backup ${backup.name} (PANEL_MAX_BACKUPS=${env.maxBackups}).`,
        });
      } catch {
        /* ignore */
      }
    }
  }

  private async collect(root: string, skipDir: string, depth = 0): Promise<string[]> {
    if (depth > 8) return [];
    const out: string[] = [];
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      return out;
    }
    for (const name of entries) {
      const full = path.join(root, name);
      if (path.resolve(full) === path.resolve(skipDir)) continue;
      let stats;
      try {
        stats = await stat(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        out.push(...(await this.collect(full, skipDir, depth + 1)));
      } else if (stats.isFile()) {
        // The session secret never leaves the host.
        if (name === '.session-secret') continue;
        out.push(full);
      }
    }
    return out;
  }

  private async readForArchive(
    file: string,
    relative: string,
    includeSecrets: boolean,
  ): Promise<Buffer | null> {
    try {
      const raw = await readFile(file);
      if (includeSecrets) return raw;

      if (relative === '.env') {
        return Buffer.from(stripEnvSecrets(raw.toString('utf8')), 'utf8');
      }
      if (relative === 'panel.json') {
        try {
          const parsed = JSON.parse(raw.toString('utf8')) as {
            users?: Array<Record<string, unknown>>;
          };
          if (Array.isArray(parsed.users)) {
            parsed.users = parsed.users.map((user) => ({ ...user, passwordHash: '[redacted]' }));
          }
          return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        } catch {
          return raw;
        }
      }
      return raw;
    } catch {
      return null;
    }
  }
}

function stripEnvSecrets(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^\s*(?:export\s+)?POL_API_KEY\s*=/.test(line) ? 'POL_API_KEY=[redacted]' : line))
    .join('\n');
}

async function countZipEntries(file: string): Promise<number> {
  try {
    const buffer = await readFile(file);
    // Walk local file headers (cheap replay using the central directory).
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd === -1) return 0;
    return buffer.readUInt16LE(eocd + 10);
  } catch {
    return 0;
  }
}

async function zipContainsSecrets(file: string): Promise<boolean> {
  try {
    const buffer = await readFile(file);
    const text = buffer.toString('latin1');
    if (text.includes('secrets included: yes')) return true;
    if (text.includes('POL_API_KEY=[redacted]') || text.includes('[redacted]')) return false;
    return /POL_API_KEY=[^r\s]/.test(text);
  } catch {
    return false;
  }
}

const GLOBAL_KEY = Symbol.for('zes.panel.backup-service');

type GlobalWithBackups = typeof globalThis & { [GLOBAL_KEY]?: BackupService };

export function getBackupService(): BackupService {
  const scope = globalThis as GlobalWithBackups;
  if (!scope[GLOBAL_KEY]) scope[GLOBAL_KEY] = new BackupService();
  return scope[GLOBAL_KEY] as BackupService;
}
