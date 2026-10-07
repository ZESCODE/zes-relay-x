import type { LogEntry, LogLevel, LogSource } from '@/lib/types';
import { guard } from '@/server/auth';
import { apiSseStream } from '@/server/sse-server';
import { route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SSE tail: every new log entry is pushed as it is written, with an initial
 * backlog so a freshly opened viewer is never empty. Filters are applied
 * server-side so a filtered viewer transfers less data.
 */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    const url = new URL(request.url);
    const levelFilter = url.searchParams.get('level');
    const sourceFilter = url.searchParams.get('source');
    const q = url.searchParams.get('q')?.toLowerCase() ?? '';
    const regexRaw = url.searchParams.get('regex') === 'true' ? url.searchParams.get('q') : null;
    const backlog = Number.parseInt(url.searchParams.get('backlog') ?? '100', 10);

    const levels = levelFilter && levelFilter !== 'all' ? new Set(levelFilter.split(',')) : null;
    const sources = sourceFilter && sourceFilter !== 'all' ? new Set(sourceFilter.split(',')) : null;
    let regex: RegExp | null = null;
    if (regexRaw) {
      try {
        regex = new RegExp(regexRaw, 'i');
      } catch {
        regex = null;
      }
    }

    const matches = (entry: LogEntry): boolean => {
      if (levels && !levels.has(entry.level as LogLevel)) return false;
      if (sources && !sources.has(entry.source as LogSource)) return false;
      if (regex && !regex.test(entry.message)) return false;
      if (!regex && q && !entry.message.toLowerCase().includes(q)) return false;
      return true;
    };

    const bus = getLogBus();
    return apiSseStream(request, {
      initial: () => {
        const snapshot = bus.snapshot();
        const filtered = snapshot.filter(matches);
        const limit = Number.isFinite(backlog) ? Math.min(Math.max(backlog, 0), 1000) : 100;
        return [
          {
            event: 'hello',
            data: {
              buffered: filtered.length,
              bufferSize: snapshot.length,
              filters: { level: levelFilter, source: sourceFilter, q },
            },
          },
          ...filtered.slice(-limit).map((entry) => ({ event: 'log', data: entry, id: entry.id })),
        ];
      },
      subscribe: (emit) =>
        bus.subscribe((entry) => {
          if (matches(entry)) emit('log', entry, entry.id);
        }),
      heartbeatMs: 15_000,
    });
  },
  { logAccess: false },
);
