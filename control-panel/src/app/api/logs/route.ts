import type { LogLevel, LogQuery, LogSource } from '@/lib/types';
import { guard } from '@/server/auth';
import { ApiHttpError, ok, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const SOURCES: LogSource[] = ['panel', 'relay', 'access', 'system'];

/** Paginated tail of the merged log buffer (newest page by default). */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    const url = new URL(request.url);
    const params = url.searchParams;

    const levelRaw = params.get('level');
    if (levelRaw && levelRaw !== 'all') {
      for (const level of levelRaw.split(',')) {
        if (!LEVELS.includes(level as LogLevel)) {
          throw new ApiHttpError('validation_failed', `Unknown log level "${level}".`, 422);
        }
      }
    }

    const sourceRaw = params.get('source');
    if (sourceRaw && sourceRaw !== 'all') {
      for (const source of sourceRaw.split(',')) {
        if (!SOURCES.includes(source as LogSource)) {
          throw new ApiHttpError('validation_failed', `Unknown log source "${source}".`, 422);
        }
      }
    }

    const limit = Number.parseInt(params.get('limit') ?? '200', 10);
    const sinceMs = Number.parseInt(params.get('sinceMs') ?? '0', 10);
    const cursor = params.get('cursor') ?? undefined;

    const query: LogQuery = {
      limit: Number.isFinite(limit) ? limit : 200,
      cursor,
      level: (levelRaw as LogQuery['level']) ?? 'all',
      source: (sourceRaw as LogQuery['source']) ?? 'all',
      q: params.get('q') ?? undefined,
      regex: params.get('regex') === 'true',
      sinceMs: Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined,
    };

    if (query.regex && query.q) {
      try {
        new RegExp(query.q);
      } catch (error) {
        throw new ApiHttpError(
          'validation_failed',
          `Invalid regular expression: ${error instanceof Error ? error.message : 'unknown error'}`,
          422,
        );
      }
    }

    return ok(getLogBus().read(query));
  },
  { logAccess: false },
);
