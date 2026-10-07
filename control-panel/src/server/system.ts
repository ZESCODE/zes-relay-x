import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { SystemInfo } from '@/lib/types';
import { env } from './env';
import { directorySizeSync, paths, sha256File } from './fs-paths';
import { getRelayManager } from './relay-manager';
import { maskSecret } from './redact';

const execFileAsync = promisify(execFile);

/**
 * Runtime inventory for the admin page: versions, hashes, sizes and the
 * (masked) environment the panel is running with.
 */

const STARTED_AT = new Date().toISOString();

let pythonVersionCache: { value: string | null; at: number } | null = null;

export async function detectPythonVersion(): Promise<string | null> {
  if (pythonVersionCache && Date.now() - pythonVersionCache.at < 60_000) {
    return pythonVersionCache.value;
  }
  try {
    const { stdout, stderr } = await execFileAsync(env.pythonBin, ['--version'], { timeout: 3000 });
    const text = `${stdout}${stderr}`.trim();
    const value = text.replace(/^Python\s+/i, 'Python ') || null;
    pythonVersionCache = { value, at: Date.now() };
    return value;
  } catch {
    pythonVersionCache = { value: null, at: Date.now() };
    return null;
  }
}

export async function collectSystemInfo(): Promise<SystemInfo> {
  const manager = getRelayManager();
  const script = await manager.resolveScriptPath();
  const [pythonVersion, scriptSha] = await Promise.all([
    detectPythonVersion(),
    script ? sha256File(script) : Promise.resolve(null),
  ]);
  const memory = process.memoryUsage();

  return {
    panelVersion: env.panelVersion,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    arch: process.arch,
    pid: process.pid,
    pythonVersion,
    pythonBin: env.pythonBin,
    relayScript: script,
    relayScriptSha256: scriptSha,
    dataDir: paths().dataDir,
    dataDirSizeBytes: directorySizeSync(paths().dataDir),
    startedAt: STARTED_AT,
    uptimeMs: Date.now() - new Date(STARTED_AT).getTime(),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
    },
    env: maskedEnvironment(),
  };
}

/** Environment variables the panel reads, with secrets masked. */
export function maskedEnvironment(): Array<{ key: string; value: string }> {
  const keys = [
    'PANEL_HOST',
    'PANEL_PORT',
    'PANEL_ALLOW_PUBLIC',
    'PANEL_FRAME_ANCESTORS',
    'PANEL_EMBEDDABLE',
    'PANEL_DATA_DIR',
    'PANEL_SESSION_TTL_HOURS',
    'PANEL_TRUST_PROXY',
    'PANEL_RELAY_SCRIPT',
    'PANEL_RELAY_SCRIPT_FALLBACK',
    'PANEL_PYTHON_BIN',
    'PANEL_HEALTH_INTERVAL_MS',
    'PANEL_HEALTH_TIMEOUT_MS',
    'PANEL_AUTORESTART',
    'PANEL_SHUTDOWN_GRACE_MS',
    'PANEL_START_TIMEOUT_MS',
    'PANEL_RESTART_BACKOFF_MS',
    'PANEL_LOGIN_RATE_LIMIT',
    'PANEL_CHAT_RATE_LIMIT',
    'PANEL_RATE_WINDOW_MS',
    'PANEL_MAX_LOG_ENTRIES',
    'PANEL_METRICS_SAMPLES',
    'PANEL_METRICS_BUCKETS',
    'PANEL_PANEL_LOG_MAX_BYTES',
    'PANEL_PANEL_LOG_KEEP',
    'PANEL_MAX_ERRORS',
    'PANEL_MAX_PRESETS',
    'PANEL_MAX_BACKUPS',
    'PANEL_CHAT_MAX_BODY_BYTES',
    'PANEL_REQUEST_TIMEOUT_MS',
    'POL_RELAY_PORT',
    'POL_UPSTREAM_BASE',
    'POL_SKIP_AUTH',
    'PANEL_RELAY_BEARER',
    'PANEL_SESSION_SECRET',
    'PANEL_ADMIN_PASSWORD',
    'POL_API_KEY',
    'NODE_ENV',
  ];

  const secretKeys = new Set([
    'PANEL_SESSION_SECRET',
    'PANEL_ADMIN_PASSWORD',
    'POL_API_KEY',
    'PANEL_RELAY_BEARER',
  ]);

  const out: Array<{ key: string; value: string }> = [];
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    out.push({
      key,
      value: secretKeys.has(key) ? maskSecret(raw) : raw,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export { STARTED_AT };
