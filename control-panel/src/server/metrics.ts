import { randomUUID } from 'node:crypto';
import type {
  ErrorEntry,
  MetricCounters,
  MetricRange,
  MetricsErrors,
  MetricsSummary,
  MetricsTimeseries,
  MetricsTimeseriesPoint,
  ModelMetric,
} from '@/lib/types';
import { env } from './env';
import { readJsonFile, paths, writeJsonAtomic } from './fs-paths';
import { redactText } from './redact';
import { truncate } from '@/lib/format';
import { RingBuffer, maxOf, mean, percentile, round } from './ring-buffer';
import type { RelayAccessRecord } from './relay-log-parser';

/**
 * Live metrics.
 *
 * Two producers feed the same counter family:
 *   1. the panel's own proxy routes (`source: 'panel'`) — rich records with
 *      token usage, byte counts and latency breakdowns;
 *   2. the relay's stderr access log (`source: 'relay'`) — lightweight records
 *      covering traffic that never touched the panel.
 * Panel-proxied requests are correlated through an `x-panel-request-id` header
 * which the relay echoes as `rid=` in its access line, so nothing is counted
 * twice.
 *
 * All buffers are append-only and read through snapshots.
 */

export interface RequestRecord {
  source: 'panel' | 'relay';
  endpoint: string;
  model: string | null;
  status: number;
  streamed: boolean;
  ttfbMs?: number | null;
  durationMs: number;
  bytesIn?: number;
  bytesOut?: number;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  error?: { code: string; message: string } | null;
  requestId?: string | null;
  at?: string;
}

interface MinuteBucket {
  t: number;
  requests: number;
  errors: number;
  tokensPrompt: number;
  tokensCompletion: number;
  bytesIn: number;
  bytesOut: number;
  latencies: number[];
  ttfb: number[];
  statuses: Record<string, number>;
  models: Record<string, number>;
}

interface Sample {
  t: number;
  requestsPerMinute: number;
  errorsPerMinute: number;
  activeStreams: number;
  p95: number | null;
  lastLatency: number | null;
}

interface ModelAggregate {
  requests: number;
  errors: number;
  streams: number;
  tokensPrompt: number;
  tokensCompletion: number;
  bytesIn: number;
  bytesOut: number;
  latencySum: number;
  latencyCount: number;
  latencies: RingBuffer<number>;
  lastUsedAt: string | null;
}

const BUCKET_MS = 60_000;
const MAX_PER_BUCKET_LATENCIES = 400;
const DEDUP_WINDOW = 500;
const MAX_MODEL_TRACKED = 200;

export class Metrics {
  private readonly buckets: RingBuffer<MinuteBucket>;
  private readonly samples: RingBuffer<Sample>;
  private readonly latencies: RingBuffer<number>;
  private readonly errors: RingBuffer<ErrorEntry>;
  private readonly dedup: RingBuffer<string>;
  /** Monotonic request timestamps for accurate short-window rates. */
  private readonly requestTimes: RingBuffer<{ t: number; err: boolean }>;

  private counters: MetricCounters = emptyCounters();
  private byStatus: Record<string, number> = {};
  private byEndpoint: Record<string, number> = {};
  private byModel = new Map<string, ModelAggregate>();
  private activeStreams = 0;
  private since = new Date().toISOString();
  private lastError: MetricsSummary['lastError'] = null;
  private relay = { requestsObserved: 0, errorsObserved: 0, parseWarnings: 0 };
  private dirty = false;

  constructor() {
    this.buckets = new RingBuffer<MinuteBucket>(env.metricsBuckets);
    this.samples = new RingBuffer<Sample>(env.metricsSamples);
    this.latencies = new RingBuffer<number>(env.metricsSamples);
    this.errors = new RingBuffer<ErrorEntry>(env.maxErrors);
    this.dedup = new RingBuffer<string>(DEDUP_WINDOW);
    this.requestTimes = new RingBuffer<{ t: number; err: boolean }>(10_000);
  }

  /* ── ingestion ─────────────────────────────────────────────────────────── */

  record(record: RequestRecord): void {
    if (record.source === 'relay' && record.requestId && this.isDuplicate(record.requestId)) {
      return;
    }
    if (record.source === 'panel' && record.requestId) {
      this.dedup.push(record.requestId);
    }

    const at = record.at ?? new Date().toISOString();
    const status = record.status;
    const okStatus = status >= 200 && status < 400;

    this.counters.requestsTotal += 1;
    if (okStatus) this.counters.requestsSuccess += 1;
    else this.counters.requestsError += 1;

    if (record.streamed) {
      this.counters.streams += 1;
      if (okStatus) this.counters.streamsCompleted += 1;
      else this.counters.streamsAborted += 1;
    }

    const bytesIn = record.bytesIn ?? 0;
    const bytesOut = record.bytesOut ?? 0;
    this.counters.bytesIn += bytesIn;
    this.counters.bytesOut += bytesOut;

    const usage = record.usage ?? null;
    if (usage) {
      this.counters.tokensPrompt += usage.prompt_tokens;
      this.counters.tokensCompletion += usage.completion_tokens;
      this.counters.tokensTotal +=
        usage.total_tokens || usage.prompt_tokens + usage.completion_tokens;
    }

    if (typeof record.ttfbMs === 'number' && Number.isFinite(record.ttfbMs)) {
      this.counters.ttfbSumMs += record.ttfbMs;
    }
    if (Number.isFinite(record.durationMs) && record.durationMs >= 0) {
      this.counters.latencySumMs += record.durationMs;
      this.latencies.push(record.durationMs);
    }

    this.requestTimes.push({ t: Date.now(), err: !okStatus });
    this.byStatus[String(status)] = (this.byStatus[String(status)] ?? 0) + 1;
    this.byEndpoint[record.endpoint] = (this.byEndpoint[record.endpoint] ?? 0) + 1;

    if (record.model) this.touchModel(record.model, record, at);

    const bucket = this.bucketFor(at);
    bucket.requests += 1;
    bucket.tokensPrompt += usage?.prompt_tokens ?? 0;
    bucket.tokensCompletion += usage?.completion_tokens ?? 0;
    bucket.bytesIn += bytesIn;
    bucket.bytesOut += bytesOut;
    bucket.statuses[String(status)] = (bucket.statuses[String(status)] ?? 0) + 1;
    if (record.model) bucket.models[record.model] = (bucket.models[record.model] ?? 0) + 1;
    if (Number.isFinite(record.durationMs) && record.durationMs >= 0) {
      pushCapped(bucket.latencies, record.durationMs, MAX_PER_BUCKET_LATENCIES);
    }
    if (typeof record.ttfbMs === 'number' && Number.isFinite(record.ttfbMs)) {
      pushCapped(bucket.ttfb, record.ttfbMs, MAX_PER_BUCKET_LATENCIES);
    }

    if (!okStatus) {
      bucket.errors += 1;
      const entry = this.makeErrorEntry(record, at);
      this.errors.push(entry);
      this.lastError = {
        at,
        message: entry.message,
        status: entry.status,
        model: entry.model,
      };
      if (record.source === 'relay') this.relay.errorsObserved += 1;
      if (status >= 500) this.counters.upstreamErrors += 1;
    }

    this.dirty = true;
  }

  /** Feed a relay access record parsed from the relay's stderr stream. */
  recordRelayAccess(record: RelayAccessRecord): void {
    this.relay.requestsObserved += 1;
    this.record({
      source: 'relay',
      endpoint: record.path,
      model: record.model,
      status: record.status,
      streamed: record.stream === true,
      durationMs: record.durationMs ?? 0,
      requestId: record.requestId,
      at: record.at ?? undefined,
    });
  }

  recordParseWarning(): void {
    this.relay.parseWarnings += 1;
    this.dirty = true;
  }

  streamOpened(): void {
    this.activeStreams += 1;
    this.dirty = true;
  }

  streamClosed(): void {
    this.activeStreams = Math.max(0, this.activeStreams - 1);
    this.dirty = true;
  }

  recordRestart(): void {
    this.counters.restarts += 1;
    this.dirty = true;
  }

  /* ── reads ─────────────────────────────────────────────────────────────── */

  tick(): Sample {
    const now = Date.now();
    const recent = this.recentRequests(60_000);
    const sample: Sample = {
      t: now,
      requestsPerMinute: recent.total,
      errorsPerMinute: recent.errors,
      activeStreams: this.activeStreams,
      p95: percentile(this.latencies.snapshot(), 0.95),
      lastLatency: this.lastLatency(),
    };
    this.samples.push(sample);
    return sample;
  }

  summary(): MetricsSummary {
    const latencies = this.latencies.snapshot();
    const recent = this.recentRequests(60_000);
    const last5s = this.recentRequests(5_000);
    const attempts = this.counters.requestsTotal;
    const successRate =
      attempts === 0 ? null : round((this.counters.requestsSuccess / attempts) * 100, 2);

    return {
      since: this.since,
      now: new Date().toISOString(),
      uptimeMs: Date.now() - new Date(this.since).getTime(),
      counters: { ...this.counters },
      rates: {
        perMinute: recent.total,
        perSecond: round(last5s.total / 5, 2) ?? 0,
        errorsPerMinute: recent.errors,
        successRate,
      },
      activeStreams: this.activeStreams,
      latency: {
        count: latencies.length,
        p50: round(percentile(latencies, 0.5), 1),
        p95: round(percentile(latencies, 0.95), 1),
        p99: round(percentile(latencies, 0.99), 1),
        avg: round(mean(latencies), 1),
        max: round(maxOf(latencies), 1),
        last: this.lastLatency(),
        lastTtfb: this.lastTtfb(),
      },
      byStatus: { ...this.byStatus },
      byEndpoint: { ...this.byEndpoint },
      byModel: this.modelMetrics(),
      lastError: this.lastError,
      relay: { ...this.relay },
      buffers: {
        samples: this.samples.size,
        buckets: this.buckets.size,
        errors: this.errors.size,
        logs: 0,
      },
    };
  }

  timeseries(range: MetricRange): MetricsTimeseries {
    const rangeMs = rangeToMs(range);
    const to = Date.now();
    const from = to - rangeMs;
    const buckets = this.buckets
      .snapshot()
      .filter((bucket) => bucket.t >= from - BUCKET_MS && bucket.t <= to);

    const maxPoints = 240;
    const groupSize = Math.max(1, Math.ceil(buckets.length / maxPoints));
    const points: MetricsTimeseriesPoint[] = [];

    for (let index = 0; index < buckets.length; index += groupSize) {
      const group = buckets.slice(index, index + groupSize);
      if (group.length === 0) continue;
      const first = group[0]!;
      const latencies = group.flatMap((bucket) => bucket.latencies);
      const requests = group.reduce((total, bucket) => total + bucket.requests, 0);
      const errors = group.reduce((total, bucket) => total + bucket.errors, 0);
      const tokensPrompt = group.reduce((total, bucket) => total + bucket.tokensPrompt, 0);
      const tokensCompletion = group.reduce((total, bucket) => total + bucket.tokensCompletion, 0);
      const bytesOut = group.reduce((total, bucket) => total + bucket.bytesOut, 0);
      points.push({
        t: new Date(first.t).toISOString(),
        requests,
        errors,
        tokensPrompt,
        tokensCompletion,
        bytesOut,
        avgLatencyMs: round(mean(latencies), 1),
        p50: round(percentile(latencies, 0.5), 1),
        p95: round(percentile(latencies, 0.95), 1),
        p99: round(percentile(latencies, 0.99), 1),
      });
    }

    const totals = points.reduce(
      (accumulator, point) => ({
        requests: accumulator.requests + point.requests,
        errors: accumulator.errors + point.errors,
        tokensPrompt: accumulator.tokensPrompt + point.tokensPrompt,
        tokensCompletion: accumulator.tokensCompletion + point.tokensCompletion,
        bytesOut: accumulator.bytesOut + point.bytesOut,
      }),
      { requests: 0, errors: 0, tokensPrompt: 0, tokensCompletion: 0, bytesOut: 0 },
    );

    return {
      range,
      bucketMs: BUCKET_MS * groupSize,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      points,
      totals,
    };
  }

  recentSamples(limit = 120): Sample[] {
    const all = this.samples.snapshot();
    return all.length > limit ? all.slice(all.length - limit) : all;
  }

  modelMetrics(): ModelMetric[] {
    const items: ModelMetric[] = [];
    for (const [model, aggregate] of this.byModel) {
      const latencies = aggregate.latencies.snapshot();
      items.push({
        model,
        requests: aggregate.requests,
        errors: aggregate.errors,
        streams: aggregate.streams,
        tokensPrompt: aggregate.tokensPrompt,
        tokensCompletion: aggregate.tokensCompletion,
        bytesIn: aggregate.bytesIn,
        bytesOut: aggregate.bytesOut,
        avgLatencyMs:
          aggregate.latencyCount === 0
            ? null
            : round(aggregate.latencySum / aggregate.latencyCount, 1),
        p95LatencyMs: round(percentile(latencies, 0.95), 1),
        lastUsedAt: aggregate.lastUsedAt,
      });
    }
    return items.sort((a, b) => b.requests - a.requests);
  }

  errorList(limit = 50): MetricsErrors {
    const all = this.errors.snapshot();
    const items = all.length > limit ? all.slice(all.length - limit) : all;
    return { total: all.length, items: [...items].reverse() };
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  clear(targets: { metrics: boolean; errors: boolean }): void {
    if (targets.metrics) {
      this.counters = emptyCounters();
      this.byStatus = {};
      this.byEndpoint = {};
      this.byModel.clear();
      this.buckets.clear();
      this.samples.clear();
      this.latencies.clear();
      this.dedup.clear();
      this.requestTimes.clear();
      this.since = new Date().toISOString();
      this.relay = { requestsObserved: 0, errorsObserved: 0, parseWarnings: 0 };
      this.lastError = null;
      this.activeStreams = 0;
      this.dirty = true;
    }
    if (targets.errors) {
      this.errors.clear();
      this.lastError = null;
      this.dirty = true;
    }
  }

  /** Restore counters persisted by a previous process. */
  async hydrate(): Promise<void> {
    const file = paths().metricsJson;
    const stored = await readJsonFile<{
      counters?: Partial<MetricCounters>;
      byStatus?: Record<string, number>;
      byEndpoint?: Record<string, number>;
      byModel?: Array<Partial<ModelMetric> & { model: string }>;
      since?: string;
      relay?: { requestsObserved: number; errorsObserved: number; parseWarnings: number };
    } | null>(file, null);
    if (!stored) return;

    this.counters = { ...emptyCounters(), ...(stored.counters ?? {}) };
    this.byStatus = stored.byStatus ?? {};
    this.byEndpoint = stored.byEndpoint ?? {};
    this.since = stored.since ?? this.since;
    this.relay = { ...this.relay, ...(stored.relay ?? {}) };
    for (const model of stored.byModel ?? []) {
      const aggregate = this.modelAggregate(model.model);
      aggregate.requests = model.requests ?? 0;
      aggregate.errors = model.errors ?? 0;
      aggregate.streams = model.streams ?? 0;
      aggregate.tokensPrompt = model.tokensPrompt ?? 0;
      aggregate.tokensCompletion = model.tokensCompletion ?? 0;
      aggregate.bytesIn = model.bytesIn ?? 0;
      aggregate.bytesOut = model.bytesOut ?? 0;
      aggregate.lastUsedAt = model.lastUsedAt ?? null;
    }
  }

  async flush(force = false): Promise<void> {
    if (!this.dirty && !force) return;
    this.dirty = false;
    try {
      await writeJsonAtomic(paths().metricsJson, {
        counters: this.counters,
        byStatus: this.byStatus,
        byEndpoint: this.byEndpoint,
        byModel: this.modelMetrics(),
        since: this.since,
        relay: this.relay,
        savedAt: new Date().toISOString(),
      });
    } catch {
      // Persistence is best effort — never break request handling for it.
    }
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private bucketFor(at: string): MinuteBucket {
    const timestamp = new Date(at).getTime();
    const bucketStart = Math.floor((Number.isFinite(timestamp) ? timestamp : Date.now()) / BUCKET_MS) * BUCKET_MS;
    const all = this.buckets.snapshot();
    const last = all.length > 0 ? all[all.length - 1]! : null;
    if (last && last.t === bucketStart) return last;

    let bucket: MinuteBucket | undefined;
    if (last && last.t < bucketStart) {
      // Fill skipped minutes so charts stay linear.
      const steps = Math.min(
        Math.floor((bucketStart - last.t) / BUCKET_MS),
        this.buckets.capacity - 1,
      );
      for (let step = 1; step < steps; step += 1) {
        this.buckets.push(createBucket(last.t + step * BUCKET_MS));
      }
      bucket = createBucket(bucketStart);
    } else {
      bucket = createBucket(bucketStart);
    }
    this.buckets.push(bucket);
    return bucket;
  }

  private touchModel(model: string, record: RequestRecord, at: string): void {
    const aggregate = this.modelAggregate(model);
    aggregate.requests += 1;
    if (record.status >= 400) aggregate.errors += 1;
    if (record.streamed && record.status < 400) aggregate.streams += 1;
    aggregate.tokensPrompt += record.usage?.prompt_tokens ?? 0;
    aggregate.tokensCompletion += record.usage?.completion_tokens ?? 0;
    aggregate.bytesIn += record.bytesIn ?? 0;
    aggregate.bytesOut += record.bytesOut ?? 0;
    if (Number.isFinite(record.durationMs) && record.durationMs >= 0) {
      aggregate.latencySum += record.durationMs;
      aggregate.latencyCount += 1;
      aggregate.latencies.push(record.durationMs);
    }
    aggregate.lastUsedAt = at;
  }

  private modelAggregate(model: string): ModelAggregate {
    let aggregate = this.byModel.get(model);
    if (!aggregate) {
      if (this.byModel.size >= MAX_MODEL_TRACKED) {
        // Evict the least used model to bound memory.
        let victim: string | null = null;
        let lowest = Number.POSITIVE_INFINITY;
        for (const [key, value] of this.byModel) {
          if (value.requests < lowest) {
            lowest = value.requests;
            victim = key;
          }
        }
        if (victim) this.byModel.delete(victim);
      }
      aggregate = {
        requests: 0,
        errors: 0,
        streams: 0,
        tokensPrompt: 0,
        tokensCompletion: 0,
        bytesIn: 0,
        bytesOut: 0,
        latencySum: 0,
        latencyCount: 0,
        latencies: new RingBuffer<number>(240),
        lastUsedAt: null,
      };
      this.byModel.set(model, aggregate);
    }
    return aggregate;
  }

  private makeErrorEntry(record: RequestRecord, at: string): ErrorEntry {
    const fallback = `Request failed with status ${record.status}`;
    return {
      id: randomUUID(),
      at,
      status: record.status,
      code: record.error?.code ?? `http_${record.status}`,
      message: truncate(redactText(record.error?.message ?? fallback), 500),
      endpoint: record.endpoint,
      model: record.model,
      requestId: record.requestId ?? null,
      source: record.source,
    };
  }

  private isDuplicate(requestId: string): boolean {
    return this.dedup.snapshot().includes(requestId);
  }

  private lastLatency(): number | null {
    const all = this.latencies.snapshot();
    return all.length > 0 ? round(all[all.length - 1]!, 1) : null;
  }

  private lastTtfb(): number | null {
    const buckets = this.buckets.snapshot();
    for (let index = buckets.length - 1; index >= 0; index -= 1) {
      const ttfb = buckets[index]!.ttfb;
      if (ttfb.length > 0) return round(ttfb[ttfb.length - 1]!, 1);
    }
    return null;
  }

  /** Requests (and errors) observed in the trailing window. */
  private recentRequests(windowMs: number): { total: number; errors: number } {
    const cutoff = Date.now() - windowMs;
    const times = this.requestTimes.snapshot();
    if (times.length === 0) return { total: 0, errors: 0 };
    // Timestamps are monotonic → binary search the first index inside the window.
    let low = 0;
    let high = times.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (times[mid]!.t < cutoff) low = mid + 1;
      else high = mid;
    }
    let errors = 0;
    for (let index = low; index < times.length; index += 1) {
      if (times[index]!.err) errors += 1;
    }
    return { total: times.length - low, errors };
  }
}

function createBucket(t: number): MinuteBucket {
  return {
    t,
    requests: 0,
    errors: 0,
    tokensPrompt: 0,
    tokensCompletion: 0,
    bytesIn: 0,
    bytesOut: 0,
    latencies: [],
    ttfb: [],
    statuses: {},
    models: {},
  };
}

function pushCapped(target: number[], value: number, cap: number): void {
  if (target.length >= cap) {
    // Reservoir-free bounded sampling: drop the oldest observation.
    target.shift();
  }
  target.push(value);
}

function emptyCounters(): MetricCounters {
  return {
    requestsTotal: 0,
    requestsSuccess: 0,
    requestsError: 0,
    streams: 0,
    streamsCompleted: 0,
    streamsAborted: 0,
    bytesIn: 0,
    bytesOut: 0,
    tokensPrompt: 0,
    tokensCompletion: 0,
    tokensTotal: 0,
    ttfbSumMs: 0,
    latencySumMs: 0,
    upstreamErrors: 0,
    restarts: 0,
  };
}

export function rangeToMs(range: MetricRange): number {
  switch (range) {
    case '15m':
      return 15 * 60_000;
    case '1h':
      return 60 * 60_000;
    case '6h':
      return 6 * 60 * 60_000;
    case '24h':
      return 24 * 60 * 60_000;
    default:
      return 60 * 60_000;
  }
}

export function isMetricRange(value: string | null): value is MetricRange {
  return value === '15m' || value === '1h' || value === '6h' || value === '24h';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Singleton
 * ──────────────────────────────────────────────────────────────────────────── */

const GLOBAL_KEY = Symbol.for('zes.panel.metrics');

type GlobalWithMetrics = typeof globalThis & { [GLOBAL_KEY]?: Metrics };

export function getMetrics(): Metrics {
  const scope = globalThis as GlobalWithMetrics;
  if (!scope[GLOBAL_KEY]) {
    scope[GLOBAL_KEY] = new Metrics();
  }
  return scope[GLOBAL_KEY] as Metrics;
}

export function resetMetrics(): void {
  const scope = globalThis as GlobalWithMetrics;
  delete scope[GLOBAL_KEY];
}
