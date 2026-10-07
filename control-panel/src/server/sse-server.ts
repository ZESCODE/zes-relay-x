import { encodeSse, sseResponse } from './http';

/**
 * Small helper for the panel's GET SSE endpoints.
 *
 * Guarantees: an immediate `initial` batch, a subscription torn down on client
 * disconnect, and periodic heartbeat comments so intermediary proxies keep the
 * connection open. Backpressure is handled by the stream controller — if an
 * enqueue throws, the client is gone and we unsubscribe.
 */

export interface SseFrame<T = unknown> {
  event: string;
  data: T;
  id?: number;
}

export interface SseStreamOptions {
  initial: () => SseFrame[];
  subscribe: (emit: (event: string, data: unknown, id?: number) => void) => () => void;
  heartbeatMs?: number;
}

export function apiSseStream(request: Request, options: SseStreamOptions): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown, id?: number): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeSse(event, data, id)));
        } catch {
          closed = true;
          cleanup?.();
        }
      };

      for (const frame of options.initial()) {
        emit(frame.event, frame.data, frame.id);
      }

      cleanup = options.subscribe(emit);

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          closed = true;
          cleanup?.();
        }
      }, options.heartbeatMs ?? 15_000);

      const teardown = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        cleanup?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener('abort', teardown);
    },
    cancel() {
      closed = true;
      cleanup?.();
    },
  });

  return sseResponse(stream);
}
