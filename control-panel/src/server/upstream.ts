import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HealthProbe, ModelInfo } from '@/lib/types';
import { env } from './env';
import { redactText } from './redact';

const execFileAsync = promisify(execFile);

/**
 * Thin client for the relay's OpenAI-compatible surface.
 *
 * The panel is a *client* of the relay — it never re-implements the wire
 * protocol, it only calls it. Every helper here is used from Node route
 * handlers, never from the browser.
 */

export class RelayUnavailableError extends Error {
  readonly code = 'relay_unavailable';
  constructor(message: string) {
    super(redactText(message));
    this.name = 'RelayUnavailableError';
  }
}

export const RELAY_HOST = '127.0.0.1';

export function relayBaseUrl(port: number): string {
  return `http://${RELAY_HOST}:${port}`;
}

export interface RelayFetchInit extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** fetch() against the relay with a hard timeout and redacted error surface. */
export async function relayFetch(
  port: number,
  path: string,
  init: RelayFetchInit = {},
): Promise<Response> {
  const { timeoutMs = env.requestTimeoutMs, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const headers = new Headers(rest.headers ?? {});
  if (env.relayBearer && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${env.relayBearer}`);
  }

  try {
    return await fetch(`${relayBaseUrl(port)}${path}`, {
      ...rest,
      headers,
      signal: controller.signal,
      cache: 'no-store',
      // Node 18+ undici honours this for streaming responses.
      redirect: 'manual',
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `Relay on port ${port} did not respond within ${timeoutMs} ms`
          : error.message
        : String(error);
    throw new RelayUnavailableError(message);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface ModelsFetchResult {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  models: ModelInfo[];
  error: string | null;
  raw: unknown;
}

/** GET /v1/models on the relay. Never throws — returns ok:false instead. */
export async function fetchRelayModels(
  port: number,
  timeoutMs = env.healthTimeoutMs,
): Promise<ModelsFetchResult> {
  const startedAt = Date.now();
  try {
    const response = await relayFetch(port, '/v1/models', { method: 'GET', timeoutMs });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        models: [],
        error: redactText(text.slice(0, 500)) || `HTTP ${response.status}`,
        raw: null,
      };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        models: [],
        error: 'Relay returned a non-JSON body for /v1/models',
        raw: null,
      };
    }
    const models = extractModels(parsed);
    return { ok: true, status: response.status, latencyMs, models, error: null, raw: parsed };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      models: [],
      error: redactText(error instanceof Error ? error.message : String(error)),
      raw: null,
    };
  }
}

/** Health probe used by the lifecycle manager (2s budget by default). */
export async function probeRelayHealth(
  port: number,
  timeoutMs = env.healthTimeoutMs,
): Promise<HealthProbe> {
  const result = await fetchRelayModels(port, timeoutMs);
  return {
    ok: result.ok,
    latencyMs: result.latencyMs,
    at: new Date().toISOString(),
    status: result.status,
    modelCount: result.ok ? result.models.length : null,
    error: result.error,
  };
}

export function extractModels(payload: unknown): ModelInfo[] {
  if (!payload || typeof payload !== 'object') return [];
  const container = payload as { data?: unknown; models?: unknown };
  const list = Array.isArray(container.data)
    ? container.data
    : Array.isArray(container.models)
      ? container.models
      : Array.isArray(payload)
        ? (payload as unknown[])
        : [];
  const out: ModelInfo[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      out.push({ id: item, object: 'model' });
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : null;
      if (!id) continue;
      out.push({ ...record, id } as ModelInfo);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** TCP connect probe — true when something accepts connections on the port. */
export function isPortListening(port: number, host = RELAY_HOST, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Best-effort discovery of the process listening on a port, so the panel can
 * tell the operator *what* holds a port it does not own. Never used to kill.
 */
export async function findProcessOnPort(port: number): Promise<number | null> {
  const commands: Array<[string, string[]]> = [
    ['lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']],
    ['ss', ['-ltnp']],
    ['fuser', ['-n', 'tcp', String(port)]],
  ];
  for (const [command, args] of commands) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 2000 });
      const lines = command === 'ss' ? stdout.split('\n').filter((line) => line.includes(`:${port} `)) : stdout.split('\n');
      for (const line of lines) {
        const direct = Number.parseInt(line.trim(), 10);
        if (Number.isFinite(direct) && direct > 0) return direct;
        const match = /pid=(\d+)/.exec(line) ?? /(\d+)\//.exec(line);
        if (match?.[1]) {
          const pid = Number.parseInt(match[1], 10);
          if (Number.isFinite(pid) && pid > 0) return pid;
        }
      }
    } catch {
      // Command missing or no match — try the next strategy.
    }
  }
  return findProcessOnPortViaProc(port);
}

/**
 * Linux-only fallback: map the listening socket inode from /proc/net/tcp to the
 * owning pid via /proc/<pid>/fd. Works without root for processes of the same
 * user, which is exactly the "somebody else started the relay" case.
 */
async function findProcessOnPortViaProc(port: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const { readFile, readdir, readlink } = await import('node:fs/promises');
    const inodes = new Set<string>();
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let content: string;
      try {
        content = await readFile(table, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const [, localAddress, , state, , , , , , inode] = parts;
        if (state !== '0A' || !localAddress || !inode) continue; // 0A = LISTEN
        const localPort = Number.parseInt(localAddress.split(':')[1] ?? '', 16);
        if (localPort === port) inodes.add(inode);
      }
    }
    if (inodes.size === 0) return null;
    const entries = await readdir('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const fdDir = `/proc/${entry}/fd`;
      let descriptors: string[];
      try {
        descriptors = await readdir(fdDir);
      } catch {
        continue; // not our process
      }
      for (const descriptor of descriptors) {
        try {
          const target = await readlink(`${fdDir}/${descriptor}`);
          if (target.startsWith('socket:[') && inodes.has(target.slice(8, -1))) {
            return Number.parseInt(entry, 10);
          }
        } catch {
          /* raced with the process exiting */
        }
      }
    }
  } catch {
    /* /proc unavailable — nothing more we can do */
  }
  return null;
}
