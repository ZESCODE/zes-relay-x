import type { LogLevel } from '@/lib/types';

/**
 * Parser for the relay's stderr stream.
 *
 * pol_relay.py emits one access record per request:
 *
 *   [pol-relay] 2026-10-07T15:33:20Z POST /v1/chat/completions 200 model=openai 1234ms stream=true
 *
 * plus arbitrary diagnostic lines. Recognised access records feed the metrics
 * module so that traffic hitting the relay *directly* (outside the panel) is
 * still visible on the dashboard.
 */

export interface RelayAccessRecord {
  method: string;
  path: string;
  status: number;
  durationMs: number | null;
  model: string | null;
  stream: boolean | null;
  at: string | null;
  /** Correlation id echoed by the relay when the panel proxied the request. */
  requestId: string | null;
}

export interface ParsedRelayLine {
  level: LogLevel;
  message: string;
  request: RelayAccessRecord | null;
}

const ACCESS_PATTERN =
  /^(?<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?<path>\/\S*)\s+(?<status>\d{3})(?:\s+(?<rest>.*))?$/;

const PREFIX = '[pol-relay]';

export function parseRelayLine(raw: string): ParsedRelayLine {
  const trimmed = raw.replace(/\r$/, '');
  const withoutPrefix = trimmed.startsWith(PREFIX)
    ? trimmed.slice(PREFIX.length).trimStart()
    : trimmed;

  const level = inferLevel(trimmed);

  // Strip an optional leading ISO timestamp emitted by the relay.
  const timestampMatch = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)$/.exec(withoutPrefix);
  const at = timestampMatch?.[1] ?? null;
  const body = timestampMatch?.[2] ?? withoutPrefix;

  const match = ACCESS_PATTERN.exec(body);
  if (match?.groups) {
    const status = Number.parseInt(match.groups.status ?? '0', 10);
    const rest = match.groups.rest ?? '';
    const durationMs = parseDuration(rest);
    const model = parseField(rest, 'model');
    const streamRaw = parseField(rest, 'stream');
    return {
      level: levelFromStatus(status, level),
      message: trimmed,
      request: {
        method: match.groups.method ?? 'GET',
        path: match.groups.path ?? '/',
        status,
        durationMs,
        model,
        stream: streamRaw === null ? null : streamRaw === 'true',
        at,
        requestId: parseField(rest, 'rid'),
      },
    };
  }

  return { level, message: trimmed, request: null };
}

function parseField(rest: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(rest);
  if (!match) return null;
  const value = match[1];
  if (value === undefined || value === '-') return null;
  return value.replace(/^"|"$/g, '');
}

function parseDuration(rest: string): number | null {
  const match = /(?:^|\s)(\d+(?:\.\d+)?)ms(?:\s|$)/.exec(rest);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function levelFromStatus(status: number, fallback: LogLevel): LogLevel {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return fallback === 'error' ? 'error' : 'info';
}

export function inferLevel(line: string): LogLevel {
  const lower = line.toLowerCase();
  if (/\b(traceback|exception|fatal|critical)\b/.test(lower)) return 'error';
  if (/\berror\b|\bfailed\b|\bfailure\b/.test(lower)) return 'error';
  if (/\bwarn(ing)?\b/.test(lower)) return 'warn';
  if (/\bdebug\b|\[debug\]/.test(lower)) return 'debug';
  return 'info';
}

/** True when a line looks like the relay announcing its listening socket. */
export function parseListenLine(line: string): { port: number | null; upstream: string | null } | null {
  if (!/listening on/i.test(line)) return null;
  const portMatch = /:(\d{2,5})\b/.exec(line);
  const upstreamMatch = /upstream=(\S+)/.exec(line);
  return {
    port: portMatch?.[1] ? Number.parseInt(portMatch[1], 10) : null,
    upstream: upstreamMatch?.[1] ?? null,
  };
}
