'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select, Toggle } from '@/components/ui/Input';
import { useToast } from '@/lib/hooks/useToast';
import { useSSE } from '@/lib/hooks/useSSE';
import { fetchLogs, logsDownloadUrl } from '@/lib/api';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import type { LogEntry, LogLevel, LogSource } from '@/lib/types';

export interface LogViewerProps {
  /** How many lines to request in the initial backlog (SSE `backlog` param). */
  backlog?: number;
}

const ROW_HEIGHT = 22;
const OVERSCAN = 12;
const MAX_ROWS = 5000;

const LEVEL_OPTIONS = [
  { value: 'all', label: 'All levels' },
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
];

const SOURCE_OPTIONS = [
  { value: 'all', label: 'All sources' },
  { value: 'relay', label: 'relay (subprocess)' },
  { value: 'panel', label: 'panel' },
  { value: 'access', label: 'access' },
  { value: 'system', label: 'system' },
];

const LEVEL_TONE: Record<LogLevel, string> = {
  debug: 'text-white/45',
  info: 'text-white/80',
  warn: 'text-orange-200',
  error: 'text-red-200',
};

/**
 * Live log console.
 *
 * • merged relay stdout/stderr + panel + access log (server-side ring buffer)
 * • windowed rendering (only the visible slice is mounted)
 * • filters for level/source/substring/regex, freeze, auto-scroll, download
 */
export function LogViewer({ backlog = 400 }: LogViewerProps) {
  const toast = useToast();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [source, setSource] = useState<LogSource | 'all'>('all');
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [oldestCursor, setOldestCursor] = useState<string>('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const [frozenSnapshot, setFrozenSnapshot] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const { status, events, clear, reconnect, error } = useSSE({
    path: `/api/logs/stream?backlog=${backlog}`,
    bufferSize: 4000,
    onEvent: () => undefined,
  });

  // Fold SSE frames into the entry list (deduplicated by id).
  useEffect(() => {
    if (events.length === 0) return;
    setEntries((current) => {
      const seen = new Set(current.map((entry) => entry.id));
      const additions: LogEntry[] = [];
      for (const event of events) {
        if (event.event !== 'log') continue;
        try {
          const parsed = JSON.parse(event.data) as LogEntry;
          if (typeof parsed.id !== 'number' || seen.has(parsed.id)) continue;
          seen.add(parsed.id);
          additions.push(parsed);
        } catch {
          /* ignore malformed frame */
        }
      }
      if (additions.length === 0) return current;
      const merged = [...current, ...additions].sort((a, b) => a.id - b.id);
      return merged.length > MAX_ROWS ? merged.slice(merged.length - MAX_ROWS) : merged;
    });
  }, [events]);

  // Freeze captures the list as it was when the button was pressed.
  useEffect(() => {
    if (frozen) setFrozenSnapshot(entries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozen]);

  const rows = useMemo(() => {
    const source_ = frozen ? frozenSnapshot : entries;
    let filtered = source_;

    if (level !== 'all') filtered = filtered.filter((entry) => entry.level === level);
    if (source !== 'all') filtered = filtered.filter((entry) => entry.source === source);

    if (query.trim() !== '') {
      if (useRegex) {
        let regex: RegExp | null = null;
        try {
          regex = new RegExp(query, 'i');
        } catch {
          regex = null;
        }
        filtered = regex ? filtered.filter((entry) => regex!.test(entry.message)) : [];
      } else {
        const needle = query.toLowerCase();
        filtered = filtered.filter((entry) => entry.message.toLowerCase().includes(needle));
      }
    }
    return filtered;
  }, [entries, frozen, frozenSnapshot, level, query, source, useRegex]);

  const invalidRegex = useMemo(() => {
    if (!useRegex || query.trim() === '') return false;
    try {
      new RegExp(query);
      return false;
    } catch {
      return true;
    }
  }, [query, useRegex]);

  // Auto-scroll to the newest row when the user is already at the bottom.
  useEffect(() => {
    if (!autoScroll || frozen) return;
    const node = scrollRef.current;
    if (!node) return;
    if (!stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
    setScrollTop(node.scrollTop);
  }, [autoScroll, frozen, rows.length]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    observer.observe(node);
    setViewportHeight(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  const loadOlder = useCallback(async () => {
    const first = entries[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const page = await fetchLogs({ limit: 500, cursor: String(first.id) });
      setEntries((current) => {
        const seen = new Set(current.map((entry) => entry.id));
        const additions = page.entries.filter((entry) => !seen.has(entry.id));
        const merged = [...additions, ...current].sort((a, b) => a.id - b.id);
        return merged.length > MAX_ROWS ? merged.slice(0, MAX_ROWS) : merged;
      });
      setOldestCursor(page.nextCursor);
      if (page.entries.length === 0) toast.info('No older entries in the buffer');
    } catch (caught) {
      toast.error('Could not load older entries', caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingOlder(false);
    }
  }, [entries, toast]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(rows.length, start + visibleCount);
  const visible = rows.slice(start, end);

  const counts = useMemo(() => {
    const byLevel: Record<string, number> = {};
    for (const entry of rows) byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
    return byLevel;
  }, [rows]);

  return (
    <div className="space-y-3">
      {/* ── toolbar ────────────────────────────────────────────────────── */}
      <div className="glass-card flex flex-wrap items-center gap-2 rounded-2xl p-3">
        <Select
          aria-label="Filter by level"
          value={level}
          onChange={(event) => setLevel(event.target.value as LogLevel | 'all')}
          options={LEVEL_OPTIONS}
          className="w-36"
        />
        <Select
          aria-label="Filter by source"
          value={source}
          onChange={(event) => setSource(event.target.value as LogSource | 'all')}
          options={SOURCE_OPTIONS}
          className="w-44"
        />

        <div className="flex min-w-[14rem] flex-1 items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={useRegex ? 'Regular expression…' : 'Substring filter…'}
            aria-label="Filter log messages"
            aria-invalid={invalidRegex}
            className={clsx(
              'w-full rounded-xl px-3 py-2 text-sm glass-input',
              invalidRegex && 'border-red-400/60',
            )}
          />
          <button
            type="button"
            onClick={() => setUseRegex((value) => !value)}
            aria-pressed={useRegex}
            className={clsx(
              'shrink-0 rounded-xl border px-2 py-2 font-mono text-[11px] transition',
              useRegex
                ? 'border-blue-400/50 bg-blue-500/20 text-blue-100'
                : 'border-white/15 text-white/60 hover:bg-white/10',
            )}
            title="Toggle regular-expression matching"
          >
            .*
          </button>
        </div>

        <Badge tone={status === 'open' ? 'green' : status === 'error' ? 'red' : 'orange'} dot>
          {status === 'open' ? 'live' : status === 'connecting' ? 'reconnecting' : status}
        </Badge>
        <span className="text-[11px] text-white/45">
          {formatNumber(rows.length)} shown · {counts.error ?? 0} errors · {counts.warn ?? 0} warnings
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={frozen ? 'frost' : 'default'}
            onClick={() => setFrozen((value) => !value)}
            title="Stop updating the view"
          >
            {frozen ? 'Resume' : 'Freeze'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void loadOlder()} loading={loadingOlder}>
            Load older
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              clear();
              setEntries([]);
              toast.info('View cleared', 'The server buffer is untouched.');
            }}
          >
            Clear view
          </Button>
          <Button size="sm" variant="ghost" onClick={reconnect} disabled={status === 'open'}>
            Reconnect
          </Button>
          <a
            href={logsDownloadUrl({ level, source, q: query, regex: useRegex })}
            className="glass-btn inline-flex h-8 items-center rounded-xl px-3 text-xs text-white/85"
            download
          >
            Download .log
          </a>
          <a
            href={`${logsDownloadUrl({ level, source, q: query, regex: useRegex })}&format=jsonl`}
            className="glass-btn inline-flex h-8 items-center rounded-xl px-3 text-xs text-white/85"
            download
          >
            .jsonl
          </a>
        </div>
      </div>

      <div className="glass-card flex flex-wrap items-center gap-4 rounded-2xl px-3 py-2">
        <Toggle
          label="Auto-scroll"
          hint="Follow the newest lines while the stream is live."
          checked={autoScroll}
          onChange={(value) => {
            setAutoScroll(value);
            stickToBottom.current = true;
          }}
        />
        {error ? <span className="text-[11px] text-orange-200">{error}</span> : null}
        {!oldestCursor ? null : <span className="text-[11px] text-white/35">older pages available</span>}
      </div>

      {/* ── console ────────────────────────────────────────────────────── */}
      <div className="grid gap-3 xl:grid-cols-[1fr_22rem]">
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            setScrollTop(node.scrollTop);
            stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
          }}
          className="scroll-slim relative h-[32rem] overflow-y-auto rounded-2xl border border-white/10 bg-black/40 p-2 backdrop-blur"
          role="log"
          aria-label="Live log output"
          aria-live="off"
          tabIndex={0}
        >
          {rows.length === 0 ? (
            <p className="p-6 text-center text-xs text-white/40">
              No log lines match the current filters.
            </p>
          ) : (
            <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
              {visible.map((entry, index) => {
                const position = start + index;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelected(entry)}
                    style={{ position: 'absolute', top: position * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }}
                    className={clsx(
                      'log-row flex w-full items-center gap-2 overflow-hidden rounded px-1 text-left transition-colors hover:bg-white/10',
                      LEVEL_TONE[entry.level],
                      selected?.id === entry.id && 'bg-blue-500/15',
                    )}
                  >
                    <span className="shrink-0 font-mono text-[10px] text-white/35">
                      {formatDateTime(entry.at).split(', ')[1] ?? entry.at}
                    </span>
                    <span
                      className={clsx(
                        'shrink-0 rounded px-1 text-[10px] uppercase',
                        entry.level === 'error'
                          ? 'bg-red-500/20 text-red-200'
                          : entry.level === 'warn'
                            ? 'bg-orange-500/20 text-orange-200'
                            : 'bg-white/10 text-white/60',
                      )}
                    >
                      {entry.level}
                    </span>
                    <span className="shrink-0 rounded bg-white/10 px-1 font-mono text-[10px] text-white/50">
                      {entry.source}
                    </span>
                    <span className="truncate">
                      {entry.message}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── detail pane ──────────────────────────────────────────────── */}
        <div className="glass-card rounded-2xl p-4">
          <h2 className="mb-2 font-display text-sm font-semibold tracking-display text-white/85">
            Line detail
          </h2>
          {selected ? (
            <div className="space-y-2 text-xs">
              <dl className="space-y-1">
                <div className="flex justify-between gap-2">
                  <dt className="text-white/45">id</dt>
                  <dd className="font-mono text-white/75">#{selected.id}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-white/45">time</dt>
                  <dd className="font-mono text-white/75">{formatDateTime(selected.at)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-white/45">relative</dt>
                  <dd className="text-white/75">{formatRelative(selected.at)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-white/45">level</dt>
                  <dd className="text-white/75">{selected.level}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-white/45">source</dt>
                  <dd className="text-white/75">{selected.source}</dd>
                </div>
              </dl>
              {selected.request ? (
                <div className="rounded-xl border border-white/10 bg-white/5 p-2">
                  <p className="mb-1 text-[11px] uppercase tracking-widest text-white/45">
                    Parsed access record
                  </p>
                  <dl className="space-y-0.5 font-mono text-[11px] text-white/70">
                    <div>
                      {selected.request.method} {selected.request.path}
                    </div>
                    <div>status {selected.request.status}</div>
                    {selected.request.durationMs !== null ? <div>{selected.request.durationMs} ms</div> : null}
                    {selected.request.model ? <div>model {selected.request.model}</div> : null}
                    {selected.request.stream !== null ? (
                      <div>stream {String(selected.request.stream)}</div>
                    ) : null}
                  </dl>
                </div>
              ) : null}
              <pre className="code-pane scroll-slim max-h-72 whitespace-pre-wrap">
                {selected.message}
              </pre>
            </div>
          ) : (
            <p className="text-xs text-white/45">
              Select a line to inspect it. Relay access lines are parsed into method, path, status and
              duration.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default LogViewer;
