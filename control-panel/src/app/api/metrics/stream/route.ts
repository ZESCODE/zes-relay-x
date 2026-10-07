import { guard } from '@/server/auth';
import { encodeSse, route, sseResponse } from '@/server/http';
import { env } from '@/server/env';
import { getLogBus } from '@/server/log-bus';
import { getMetrics } from '@/server/metrics';
import { getRelayManager } from '@/server/relay-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SSE metrics stream: a summary frame every `PANEL_METRICS_TICK_MS` (2s in the
 * reference deployment), plus a heartbeat comment so proxies keep the socket
 * open. The client stops receiving frames when the tab is hidden because the
 * dashboard closes the EventSource.
 */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    const metrics = getMetrics();
    const manager = getRelayManager();
    const intervalMs = env.metricsStreamMs;

    const encoder = new TextEncoder();
    let timer: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(encodeSse(event, data)));
          } catch {
            closed = true;
          }
        };

        const pushSummary = (): void => {
          const summary = metrics.summary();
          summary.buffers.logs = getLogBus().bufferSize;
          const status = manager.snapshotStatus();
          send('summary', {
            ...summary,
            relay: {
              ...summary.relay,
              state: status.state ?? 'stopped',
              pid: status.pid ?? null,
              uptimeMs: status.uptimeMs ?? null,
              running: status.running ?? false,
              owned: status.owned ?? false,
            },
          });
        };

        send('hello', {
          intervalMs,
          since: metrics.summary().since,
          panelVersion: env.panelVersion,
        });
        pushSummary();

        timer = setInterval(pushSummary, intervalMs);
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            closed = true;
          }
        }, 15_000);

        request.signal.addEventListener('abort', () => {
          closed = true;
          if (timer) clearInterval(timer);
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
      cancel() {
        closed = true;
        if (timer) clearInterval(timer);
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    return sseResponse(stream);
  },
  { logAccess: false },
);
