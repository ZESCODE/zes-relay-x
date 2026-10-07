'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDocumentVisible } from './useInterval';

export interface PollState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  lastUpdatedAt: number | null;
  paused: boolean;
  refresh: () => void;
}

/**
 * Small SWR-style polling hook: keeps the previous value while refreshing,
 * pauses in hidden tabs, and supports manual refresh.
 */
export function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  options: { enabled?: boolean; pauseWhenHidden?: boolean } = {},
): PollState<T> {
  const { enabled = true, pauseWhenHidden = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const visible = useDocumentVisible();
  const fetcherRef = useRef(fetcher);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const refresh = useCallback((): void => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    inFlight.current?.abort();
    inFlight.current = controller;

    const run = async (): Promise<void> => {
      try {
        const value = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setData(value);
        setError(null);
        setLastUpdatedAt(Date.now());
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    if (intervalMs <= 0) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const paused = pauseWhenHidden && !visible;
    let handle: number | null = null;
    if (!paused) {
      handle = window.setInterval(() => void run(), intervalMs);
    }

    return () => {
      cancelled = true;
      if (handle !== null) window.clearInterval(handle);
      controller.abort();
    };
  }, [enabled, intervalMs, nonce, pauseWhenHidden, visible]);

  return {
    data,
    error,
    loading,
    lastUpdatedAt,
    paused: pauseWhenHidden && !visible,
    refresh,
  };
}
