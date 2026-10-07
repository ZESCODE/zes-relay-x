import { EventEmitter } from 'node:events';
import type { LogEntry, LogLevel, LogSource, LogsPage, LogQuery } from '@/lib/types';
import { env } from './env';
import { appendJsonlSync, paths, rotateFileIfNeeded } from './fs-paths';
import { redactText } from './redact';
import { inferLevel, parseRelayLine } from './relay-log-parser';
import { RingBuffer } from './ring-buffer';

/**
 * Central log hub.
 *
 * Producers: the relay subprocess (stdout/stderr), the panel's own structured
 * logger, and the access log written by the API middleware.
 * Consumers: `GET /api/logs` (paginated tail), `GET /api/logs/stream` (SSE),
 * the metrics module (relay access records) and the on-disk JSONL file.
 */
export interface LogBusOptions {
  capacity: number;
  /** Max bytes before data/logs/panel.jsonl rotates (0 disables persistence). */
  maxFileBytes: number;
  keepGenerations: number;
}

export interface LogInput {
  level?: LogLevel;
  source?: LogSource;
  message: string;
  request?: LogEntry['request'];
}

export class LogBus {
  private readonly ring: RingBuffer<LogEntry>;
  private readonly emitter = new EventEmitter();
  private readonly options: LogBusOptions;
  private nextId = 1;
  private total = 0;
  private fileBytes = 0;

  constructor(options: Partial<LogBusOptions> = {}) {
    this.options = {
      capacity: options.capacity ?? env.maxLogEntries,
      maxFileBytes: options.maxFileBytes ?? env.panelLogMaxBytes,
      keepGenerations: options.keepGenerations ?? env.panelLogKeep,
    };
    this.ring = new RingBuffer<LogEntry>(this.options.capacity);
    // SSE consumers can be numerous but stay well under the default limit.
    this.emitter.setMaxListeners(0);
  }

  push(input: LogInput): LogEntry {
    const message = redactText(input.message);
    const entry: LogEntry = {
      id: this.nextId,
      at: new Date().toISOString(),
      level: input.level ?? 'info',
      source: input.source ?? 'panel',
      message,
      request: input.request ?? null,
    };
    this.nextId += 1;
    this.total += 1;
    this.ring.push(entry);
    this.persist(entry);
    this.emitter.emit('entry', entry);
    return entry;
  }

  /** Split a raw chunk into lines and ingest each one. */
  ingest(source: LogSource, chunk: string, level?: LogLevel): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      if (source === 'relay') {
        const parsed = parseRelayLine(line);
        entries.push(
          this.push({
            source,
            level: level ?? parsed.level,
            message: line,
            request: parsed.request,
          }),
        );
        continue;
      }
      entries.push(
        this.push({ source, level: level ?? inferLevel(line), message: line }),
      );
    }
    return entries;
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.emitter.on('entry', listener);
    return () => {
      this.emitter.off('entry', listener);
    };
  }

  read(query: LogQuery = {}): LogsPage {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000);
    const all = this.ring.snapshot();

    const cursorId = query.cursor ? Number.parseInt(query.cursor, 10) : Number.NaN;
    const items = Number.isFinite(cursorId)
      ? all.filter((entry) => entry.id < cursorId)
      : all;
    let filtered = items;

    if (query.level && query.level !== 'all') {
      const levels = new Set(query.level.split(',') as LogLevel[]);
      filtered = filtered.filter((entry) => levels.has(entry.level));
    }
    if (query.source && query.source !== 'all') {
      const sources = new Set(query.source.split(',') as LogSource[]);
      filtered = filtered.filter((entry) => sources.has(entry.source));
    }
    if (query.q) {
      filtered = filterByText(filtered, query.q, Boolean(query.regex));
    }
    if (query.sinceMs && query.sinceMs > 0) {
      const cutoff = Date.now() - query.sinceMs;
      filtered = filtered.filter((entry) => new Date(entry.at).getTime() >= cutoff);
    }

    const page = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
    const oldest = page.length > 0 ? page[0]!.id : 0;
    const hasMore = filtered.some((entry) => entry.id < oldest);
    const first = all.length > 0 ? all[0]!.id : 0;
    const last = all.length > 0 ? all[all.length - 1]!.id : 0;

    return {
      entries: page,
      nextCursor: hasMore ? String(oldest) : '',
      bufferStartId: first,
      bufferEndId: last,
      total: this.ring.size,
    };
  }

  snapshot(): LogEntry[] {
    return this.ring.snapshot();
  }

  get bufferSize(): number {
    return this.ring.size;
  }

  get totalEntries(): number {
    return this.total;
  }

  clear(): void {
    this.ring.clear();
    this.total = 0;
  }

  private persist(entry: LogEntry): void {
    if (this.options.maxFileBytes <= 0) return;
    try {
      const file = paths().panelLog;
      appendJsonlSync(file, entry);
      // Approximate growth tracking is enough — the exact size is re-checked
      // whenever we rotate.
      this.fileBytes += entry.message.length + 160;
      if (this.fileBytes >= this.options.maxFileBytes) {
        rotateFileIfNeeded(file, this.options.maxFileBytes, this.options.keepGenerations);
        this.fileBytes = 0;
      }
    } catch {
      // Logging must never take the panel down.
    }
  }
}

function filterByText(entries: LogEntry[], query: string, asRegex: boolean): LogEntry[] {
  if (!asRegex) {
    const needle = query.toLowerCase();
    return entries.filter((entry) => entry.message.toLowerCase().includes(needle));
  }
  let regex: RegExp;
  try {
    regex = new RegExp(query, 'i');
  } catch {
    return [];
  }
  return entries.filter((entry) => regex.test(entry.message));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Process-wide singleton (survives Next.js dev HMR via globalThis)
 * ──────────────────────────────────────────────────────────────────────────── */

const GLOBAL_KEY = Symbol.for('zes.panel.log-bus');

type GlobalWithBus = typeof globalThis & { [GLOBAL_KEY]?: LogBus };

export function getLogBus(): LogBus {
  const scope = globalThis as GlobalWithBus;
  if (!scope[GLOBAL_KEY]) {
    scope[GLOBAL_KEY] = new LogBus();
  }
  return scope[GLOBAL_KEY] as LogBus;
}

export function resetLogBus(): void {
  const scope = globalThis as GlobalWithBus;
  delete scope[GLOBAL_KEY];
}
