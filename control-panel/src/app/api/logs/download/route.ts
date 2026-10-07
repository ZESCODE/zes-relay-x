import type { LogEntry } from '@/lib/types';
import { guard } from '@/server/auth';
import { ApiHttpError, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Download the buffered log (optionally filtered) as `.log` or `.jsonl`.
 * The buffer is the same data the viewer shows, so "what you see is what you
 * download".
 */
export const GET = route(
  async ({ request }) => {
    const context = await guard(request, { scope: 'read' });
    const url = new URL(request.url);
    const level = url.searchParams.get('level') ?? 'all';
    const source = url.searchParams.get('source') ?? 'all';
    const q = url.searchParams.get('q') ?? undefined;
    const regex = url.searchParams.get('regex') === 'true';
    const format = url.searchParams.get('format') === 'jsonl' ? 'jsonl' : 'log';

    if (regex && q) {
      try {
        new RegExp(q);
      } catch (error) {
        throw new ApiHttpError(
          'validation_failed',
          `Invalid regular expression: ${error instanceof Error ? error.message : 'unknown error'}`,
          422,
        );
      }
    }

    // Reuse the paginated reader with a very large limit to get the whole
    // buffer, then serialise it.
    const page = getLogBus().read({
      limit: 2000,
      level: level as never,
      source: source as never,
      q,
      regex,
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `zes-relay-logs-${stamp}`;

    if (format === 'jsonl') {
      const body = page.entries.map((entry: LogEntry) => JSON.stringify(entry)).join('\n');
      return new Response(`${body}\n`, {
        headers: {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="${base}.jsonl"`,
          'cache-control': 'no-store',
          'x-downloaded-by': context.user.username,
        },
      });
    }

    const header = [
      `# ZES Relay Control Panel log export`,
      `# generated: ${new Date().toISOString()}`,
      `# exported by: ${context.user.username}`,
      `# entries: ${page.entries.length} (buffer holds ${page.total})`,
      `# filters: level=${level} source=${source}${q ? ` q=${q}` : ''}${regex ? ' regex=true' : ''}`,
      '',
    ].join('\n');

    const body = page.entries
      .map(
        (entry: LogEntry) =>
          `${entry.at} ${entry.level.toUpperCase().padEnd(5)} [${entry.source.padEnd(6)}] ${entry.message}`,
      )
      .join('\n');

    return new Response(`${header}${body}\n`, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${base}.log"`,
        'cache-control': 'no-store',
        'x-downloaded-by': context.user.username,
      },
    });
  },
  { logAccess: false },
);
