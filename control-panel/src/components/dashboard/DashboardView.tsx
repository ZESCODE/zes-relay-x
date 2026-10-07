'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, SectionTitle } from '@/components/ui/Card';
import { Tabs } from '@/components/ui/Tabs';
import { LatencyChart } from '@/components/charts/LatencyChart';
import { RequestsChart } from '@/components/charts/RequestsChart';
import { ErrorFeed } from '@/components/dashboard/ErrorFeed';
import { HealthBadge } from '@/components/dashboard/HealthBadge';
import { ModelTable } from '@/components/dashboard/ModelTable';
import { RelayControls } from '@/components/dashboard/RelayControls';
import { StatTile } from '@/components/dashboard/StatTile';
import { useLiveMetrics, useRelayStatus, useTimeseries } from '@/lib/hooks/useLiveMetrics';
import { useDocumentVisible } from '@/lib/hooks/useInterval';
import {
  formatBytes,
  formatCompact,
  formatDateTime,
  formatDurationShort,
  formatMs,
  formatNumber,
  formatRatioPercent,
  formatRelative,
  formatUptime,
  shortId,
} from '@/lib/format';
import type {
  MetricRange,
  MetricsErrors,
  MetricsSummary,
  MetricsTimeseries,
  RelayStatus,
} from '@/lib/types';

export interface DashboardViewProps {
  initialStatus: RelayStatus;
  initialSummary: MetricsSummary;
  initialSeries: MetricsTimeseries;
  initialErrors: MetricsErrors;
  configPath: string;
}

const RANGES: Array<{ id: MetricRange; label: string }> = [
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
  { id: '6h', label: '6h' },
  { id: '24h', label: '24h' },
];

function seriesDelta(points: MetricsTimeseries['points'], key: 'requests' | 'tokensCompletion'): string | null {
  if (points.length < 2) return null;
  const current = points[points.length - 1]?.[key] ?? 0;
  const previous = points[points.length - 2]?.[key] ?? 0;
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return `+${formatCompact(current)}`;
  const change = ((current - previous) / previous) * 100;
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}

export function DashboardView({
  initialStatus,
  initialSummary,
  initialSeries,
  initialErrors,
  configPath,
}: DashboardViewProps) {
  const [range, setRange] = useState<MetricRange>('1h');
  const visible = useDocumentVisible();

  const status = useRelayStatus(initialStatus).status ?? initialStatus;
  const live = useLiveMetrics(initialSummary);
  const summary = live.summary ?? initialSummary;
  const timeseries = useTimeseries(range, range === '1h' ? initialSeries : null);
  const series = timeseries.series ?? initialSeries;

  const errorFeed = useMemo(() => {
    // Errors refresh with the summary; the newest entries are in the buffer.
    return initialErrors.items;
  }, [initialErrors]);

  const sparkRequests = useMemo(
    () => series.points.map((point) => point.requests),
    [series],
  );
  const sparkTokens = useMemo(
    () => series.points.map((point) => point.tokensCompletion),
    [series],
  );
  const sparkLatency = useMemo(
    () => series.points.map((point) => point.p95 ?? 0),
    [series],
  );

  const totalRequests = summary.counters.requestsTotal;
  const successRate = summary.rates.successRate;
  const errorRate =
    totalRequests === 0 ? null : (summary.counters.requestsError / totalRequests) * 100;
  const tokensPerSecond =
    summary.counters.tokensCompletion > 0 && status.uptimeMs
      ? summary.counters.tokensCompletion / Math.max(1, status.uptimeMs / 1000)
      : null;

  return (
    <div className="space-y-4">
      {/* ── hero: relay status + lifecycle ─────────────────────────────── */}
      <Card tone="hero" className="animate-fade-in">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h1 className="font-display text-xl font-bold tracking-display text-white/95">
                Relay control
              </h1>
              <HealthBadge status={status} />
              {status.restarts > 0 ? (
                <Badge tone="orange">{status.restarts} auto-restarts</Badge>
              ) : null}
              <Badge tone={status.owned ? 'blue' : 'neutral'}>
                {status.owned ? 'managed by panel' : 'external / adopted'}
              </Badge>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs text-white/65 sm:grid-cols-3 lg:grid-cols-4">
              <div>
                <dt className="text-white/40">Endpoint</dt>
                <dd className="font-mono">{status.baseUrl}</dd>
              </div>
              <div>
                <dt className="text-white/40">PID</dt>
                <dd className="font-mono">{status.pid ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-white/40">Uptime</dt>
                <dd className="font-mono">{status.uptimeMs ? formatUptime(status.uptimeMs) : '—'}</dd>
              </div>
              <div>
                <dt className="text-white/40">Last probe</dt>
                <dd className="font-mono">
                  {status.lastHealthAt
                    ? `${formatRelative(status.lastHealthAt)} · ${formatMs(status.lastHealthLatencyMs)}`
                    : '—'}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-white/40">Upstream base</dt>
                <dd className="truncate font-mono">{status.config.upstreamBase}</dd>
              </div>
              <div>
                <dt className="text-white/40">Auth mode</dt>
                <dd className="font-mono">
                  {status.config.skipAuth ? 'forward caller' : 'inject POL_API_KEY'}
                  {status.config.hasApiKey ? ' · key present' : status.config.skipAuth ? '' : ' · no key!'}
                </dd>
              </div>
              <div>
                <dt className="text-white/40">Script</dt>
                <dd className="truncate font-mono" title={status.script ?? undefined}>
                  {status.script ?? 'not found'}
                  {status.scriptSha256 ? ` · ${shortId(status.scriptSha256, 10)}` : ''}
                </dd>
              </div>
            </dl>
          </div>

          <div className="flex flex-col items-end gap-2">
            <RelayControls status={status} onChanged={() => undefined} layout="inline" />
            <p className="max-w-xs text-right text-[11px] text-white/40">
              {status.externalProcess.note}
            </p>
          </div>
        </div>
      </Card>

      {/* ── live tiles ─────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Requests (all sources)"
          value={formatNumber(totalRequests)}
          frost="blue"
          icon={<span aria-hidden="true">⇄</span>}
          change={seriesDelta(series.points, 'requests')}
          trend={(seriesDelta(series.points, 'requests') ?? '').startsWith('-') ? 'down' : 'up'}
          hint={`${formatNumber(summary.rates.perMinute)}/min · ${summary.rates.perSecond}/s`}
          sparkline={sparkRequests}
        />
        <StatTile
          label="Tokens generated"
          value={formatCompact(summary.counters.tokensCompletion)}
          frost="green"
          icon={<span aria-hidden="true">✎</span>}
          change={seriesDelta(series.points, 'tokensCompletion')}
          trend="up"
          hint={`${formatCompact(summary.counters.tokensPrompt)} in · ${
            tokensPerSecond ? `${tokensPerSecond.toFixed(1)} tok/s avg` : 'no data'
          }`}
          sparkline={sparkTokens}
          sparklineColor="rgb(52 211 153)"
        />
        <StatTile
          label="p95 latency"
          value={formatMs(summary.latency.p95)}
          frost="orange"
          icon={<span aria-hidden="true">⏱</span>}
          hint={`p50 ${formatMs(summary.latency.p50)} · p99 ${formatMs(summary.latency.p99)} · max ${formatMs(
            summary.latency.max,
          )}`}
          sparkline={sparkLatency}
          sparklineColor="rgb(251 146 60)"
        />
        <StatTile
          label="Success rate"
          value={summary.rates.successRate === null ? '—' : `${summary.rates.successRate.toFixed(1)}%`}
          frost={successRate !== null && successRate < 95 ? 'red' : 'green'}
          icon={<span aria-hidden="true">✔</span>}
          hint={`${formatNumber(summary.counters.requestsError)} errors · ${
            errorRate === null ? '—' : formatRatioPercent(errorRate)
          } failed`}
        />
        <StatTile
          label="Active streams"
          value={formatNumber(summary.activeStreams)}
          frost="blue"
          icon={<span aria-hidden="true">≈</span>}
          hint={`${formatNumber(summary.counters.streams)} streams · ${formatNumber(
            summary.counters.streamsAborted,
          )} aborted`}
        />
        <StatTile
          label="Bytes relayed"
          value={formatBytes(summary.counters.bytesOut)}
          frost="green"
          icon={<span aria-hidden="true">⇅</span>}
          hint={`${formatBytes(summary.counters.bytesIn)} received`}
        />
        <StatTile
          label="Relay errors (5xx)"
          value={formatNumber(summary.counters.upstreamErrors)}
          frost={summary.counters.upstreamErrors > 0 ? 'red' : 'green'}
          icon={<span aria-hidden="true">⚠</span>}
          hint={
            summary.lastError
              ? `last: ${formatRelative(summary.lastError.at)} · ${summary.lastError.status ?? '—'}`
              : 'no upstream failures'
          }
        />
        <StatTile
          label="Metrics uptime"
          value={formatDurationShort(summary.uptimeMs)}
          frost="blue"
          icon={<span aria-hidden="true">◷</span>}
          hint={`since ${formatDateTime(summary.since)}`}
        />
      </div>

      {/* ── charts ─────────────────────────────────────────────────────── */}
      <Card tone="plain">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle
            className="mb-0"
            hint={`${summary.buffers.buckets} minute buckets · ${formatNumber(series.totals.requests)} requests in view`}
          >
            Traffic
          </SectionTitle>
          <div className="flex items-center gap-2">
            <Tabs
              tabs={RANGES.map((item) => ({ id: item.id, label: item.label }))}
              active={range}
              onChange={(id) => setRange(id as MetricRange)}
            />
            <Badge tone={live.live ? 'green' : 'orange'} dot>
              {live.live ? (visible ? 'live · 2s' : 'live · paused (tab hidden)') : 'polling · 5s'}
            </Badge>
            <Button size="sm" variant="ghost" onClick={timeseries.refresh}>
              Refresh
            </Button>
          </div>
        </div>

        {timeseries.error ? (
          <p className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">
            Could not load the time series: {timeseries.error}
          </p>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-2">
          <RequestsChart points={series.points} />
          <LatencyChart points={series.points} />
        </div>
      </Card>

      {/* ── models + errors ────────────────────────────────────────────── */}
      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Card tone="plain">
          <CardHeader
            title="Models"
            subtitle="Per-model usage collected from the panel proxy and the relay access log"
            actions={<Badge tone="blue">{summary.byModel.length} seen</Badge>}
          />
          <ModelTable models={summary.byModel} />
        </Card>

        <Card tone="plain">
          <CardHeader
            title="Recent errors"
            subtitle={`${errorFeed.length} of the last ${summary.buffers.errors} buffered`}
          />
          <div className="scroll-slim max-h-[22rem] overflow-y-auto pr-1">
            <ErrorFeed errors={errorFeed} compact />
          </div>
        </Card>
      </div>

      {/* ── lifecycle + breakdowns ─────────────────────────────────────── */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card tone="plain">
          <CardHeader title="Lifecycle events" subtitle="Newest first · persisted to data/events.jsonl" />
          <ol className="space-y-2 text-xs">
            {status.events.length === 0 ? (
              <li className="text-white/40">No lifecycle events recorded yet.</li>
            ) : (
              status.events.slice(0, 8).map((event) => (
                <li key={`${event.at}-${event.kind}`} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className={
                      event.kind === 'error' || event.kind === 'health_down'
                        ? 'mt-1 size-1.5 shrink-0 rounded-full bg-red-400'
                        : event.kind === 'restart_scheduled' || event.kind === 'restart_exhausted'
                          ? 'mt-1 size-1.5 shrink-0 rounded-full bg-orange-400'
                          : 'mt-1 size-1.5 shrink-0 rounded-full bg-emerald-400'
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-white/75">{event.message}</span>
                    <span className="block font-mono text-[10px] text-white/35">
                      {event.kind} · {formatDateTime(event.at)}
                      {event.pid ? ` · pid ${event.pid}` : ''}
                    </span>
                  </span>
                </li>
              ))
            )}
          </ol>
        </Card>

        <Card tone="plain">
          <CardHeader title="Endpoints" subtitle="Request distribution by path" />
          <ul className="space-y-1.5 text-xs">
            {Object.entries(summary.byEndpoint).length === 0 ? (
              <li className="text-white/40">No requests observed yet.</li>
            ) : (
              Object.entries(summary.byEndpoint)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([endpoint, count]) => (
                  <li key={endpoint} className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-[11px] text-white/65">{endpoint}</span>
                    <span className="font-mono text-white/85">{formatNumber(count)}</span>
                  </li>
                ))
            )}
          </ul>
          <div className="glass-divider my-3" />
          <CardHeader title="Status codes" className="mb-2" />
          <ul className="flex flex-wrap gap-2 text-xs">
            {Object.entries(summary.byStatus).length === 0 ? (
              <li className="text-white/40">—</li>
            ) : (
              Object.entries(summary.byStatus)
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([status_, count]) => (
                  <li key={status_}>
                    <Badge tone={Number(status_) >= 500 ? 'red' : Number(status_) >= 400 ? 'orange' : 'green'}>
                      {status_}: {formatNumber(count)}
                    </Badge>
                  </li>
                ))
            )}
          </ul>
        </Card>

        <Card tone="plain">
          <CardHeader title="Buffers & storage" subtitle={`Config file: ${configPath}`} />
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Log entries buffered</dt>
              <dd className="font-mono text-white/80">{formatNumber(summary.buffers.logs)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Metric samples</dt>
              <dd className="font-mono text-white/80">{formatNumber(summary.buffers.samples)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Minute buckets</dt>
              <dd className="font-mono text-white/80">{formatNumber(summary.buffers.buckets)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Relay access lines seen</dt>
              <dd className="font-mono text-white/80">{formatNumber(summary.relay.requestsObserved)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Relay lines that failed to parse</dt>
              <dd className="font-mono text-white/80">{formatNumber(summary.relay.parseWarnings)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Last error</dt>
              <dd className="max-w-[12rem] truncate text-right font-mono text-white/80">
                {summary.lastError ? `${summary.lastError.status ?? ''} ${summary.lastError.message}` : '—'}
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

export default DashboardView;
