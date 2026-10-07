'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createSseParser, type SseEvent } from '@/lib/sse';

export type SseStatus = 'connecting' | 'open' | 'error' | 'closed';

export interface UseSseOptions {
  /** Endpoint to subscribe to. Pass null to stay idle. */
  path: string | null;
  enabled?: boolean;
  /** Keep at most this many events in memory (default 200). */
  bufferSize?: number;
  /** Optional named event to listen for in addition to unnamed messages. */
  eventName?: string;
  onEvent?: (event: SseEvent) => void;
}

export interface UseSseResult {
  status: SseStatus;
  events: SseEvent[];
  lastEvent: SseEvent | null;
  error: string | null;
  /** Wipe the local event buffer (used by the log "freeze" button). */
  clear: () => void;
  /** Force a fresh EventSource connection. */
  reconnect: () => void;
}

/**
 * Subscribe to a GET SSE endpoint with automatic reconnect.
 *
 * The panel streams metrics and logs over SSE. `EventSource` reconnects on its
 * own, but it cannot send POST bodies — chat streaming uses
 * `streamChatCompletion` from `@/lib/sse` instead.
 */
export function useSSE(options: UseSseOptions): UseSseResult {
  const { path, enabled = true, bufferSize = 200, eventName, onEvent } = options;
  const [status, setStatus] = useState<SseStatus>('connecting');
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const handlerRef = useRef(onEvent);

  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!path || !enabled || typeof window === 'undefined') {
      setStatus('closed');
      return;
    }
    if (typeof EventSource === 'undefined') {
      setStatus('error');
      setError('EventSource is unavailable in this browser');
      return;
    }

    let closed = false;
    const source = new EventSource(path, { withCredentials: true });
    const parser = createSseParser();

    const push = (next: SseEvent): void => {
      if (closed) return;
      handlerRef.current?.(next);
      setEvents((previous) => {
        const nextBuffer =
          previous.length >= bufferSize
            ? previous.slice(previous.length - bufferSize + 1)
            : previous.slice();
        nextBuffer.push(next);
        return nextBuffer;
      });
    };

    const handle = (message: MessageEvent<string>): void => {
      if (closed) return;
      // Normalise the raw frame through the same parser used for POST streams
      // so multi-line payloads behave identically.
      const parsed = parser.push(`data: ${message.data}\n\n`);
      if (parsed.length === 0) {
        push({ event: eventName ?? 'message', data: message.data, id: null, retry: null });
        return;
      }
      for (const event of parsed) push(event);
    };

    const onOpen = (): void => {
      if (closed) return;
      setStatus('open');
      setError(null);
    };
    const onError = (): void => {
      if (closed) return;
      setStatus(source.readyState === EventSource.CLOSED ? 'error' : 'connecting');
      setError('Stream interrupted — reconnecting…');
    };

    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    source.addEventListener('message', handle as EventListener);
    if (eventName) source.addEventListener(eventName, handle as EventListener);

    setStatus('connecting');

    return () => {
      closed = true;
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      source.removeEventListener('message', handle as EventListener);
      if (eventName) source.removeEventListener(eventName, handle as EventListener);
      source.close();
    };
  }, [bufferSize, enabled, eventName, path, generation]);

  const clear = useCallback((): void => setEvents([]), []);
  const reconnect = useCallback((): void => setGeneration((value) => value + 1), []);

  return {
    status,
    events,
    lastEvent: events.length > 0 ? events[events.length - 1]! : null,
    error,
    clear,
    reconnect,
  };
}
