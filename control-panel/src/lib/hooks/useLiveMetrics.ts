'use client';

import { useCallback, useMemo, useState } from 'react';
import { fetchMetricsSummary, fetchRelayStatus, fetchTimeseries } from '@/lib/api';
import type { MetricRange, MetricsSummary, MetricsTimeseries, RelayStatus } from '@/lib/types';
import { usePoll } from './usePoll';
import { useSSE, type SseStatus } from './useSSE';

export interface LiveMetricsResult {
  summary: MetricsSummary | null;
  status: SseStatus;
  /** True when the SSE stream is delivering frames. */
  live: boolean;
  error: string | null;
  lastFrameAt: number | null;
  refresh: () => void;
}

/**
 * Metrics feed: SSE when available, transparent polling fallback otherwise.
 * Pausing in hidden tabs happens inside `useSSE`/`usePoll` consumers, and the
 * dashboard closes the EventSource when the tab goes to the background.
 */
export function useLiveMetrics(initial: MetricsSummary | null = null): LiveMetricsResult {
  const [sseSummary, setSseSummary] = useState<MetricsSummary | null>(null);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);

  const sse = useSSE({
    path: '/api/metrics/stream',
    bufferSize: 4,
    onEvent: (event) => {
      if (event.event !== 'summary') return;
      try {
        const parsed = JSON.parse(event.data) as MetricsSummary;
        setSseSummary(parsed);
        setLastFrameAt(Date.now());
      } catch {
        /* ignore malformed frame */
      }
    },
  });

  const live = sse.status === 'open' && lastFrameAt !== null;
  const poll = usePoll(fetchMetricsSummary, live ? 0 : 5000, { enabled: !live });

  const summary = sseSummary ?? poll.data ?? initial;

  const refresh = useCallback(() => {
    poll.refresh();
  }, [poll]);

  return {
    summary,
    status: sse.status,
    live,
    error: sse.error ?? (poll.error ? poll.error.message : null),
    lastFrameAt,
    refresh,
  };
}

export interface LiveStatusResult {
  status: RelayStatus | null;
  error: string | null;
  refresh: () => void;
  lastUpdatedAt: number | null;
}

/** Relay lifecycle snapshot, polled every 3s (paused when the tab is hidden). */
export function useRelayStatus(initial: RelayStatus | null = null): LiveStatusResult {
  const poll = usePoll(fetchRelayStatus, 3000);
  return {
    status: poll.data ?? initial,
    error: poll.error?.message ?? null,
    refresh: poll.refresh,
    lastUpdatedAt: poll.lastUpdatedAt,
  };
}

export interface UseTimeseriesResult {
  series: MetricsTimeseries | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Bucketed time series for the charts, refreshed every 15s. */
export function useTimeseries(
  range: MetricRange,
  initial: MetricsTimeseries | null = null,
): UseTimeseriesResult {
  const poll = usePoll(
    useMemo(() => (signal: AbortSignal) => fetchTimeseries(range, signal), [range]),
    15_000,
  );
  return {
    series: poll.data ?? initial,
    loading: poll.loading,
    error: poll.error?.message ?? null,
    refresh: poll.refresh,
  };
}
