import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Metrics, getMetrics, resetMetrics, type RequestRecord } from '@/server/metrics';
import { percentile, RingBuffer } from '@/server/ring-buffer';
import { parseRelayLine } from '@/server/relay-log-parser';
import { LogBus } from '@/server/log-bus';

const createdDirs: string[] = [];

async function useTempDataDir(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zes-metrics-'));
  createdDirs.push(dir);
  process.env.PANEL_DATA_DIR = dir;
}

beforeEach(async () => {
  await useTempDataDir();
  process.env.PANEL_PANEL_LOG_MAX_BYTES = '0'; // keep tests off disk
});

afterEach(async () => {
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  delete process.env.PANEL_DATA_DIR;
  resetMetrics();
});

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    source: 'panel',
    endpoint: '/v1/chat/completions',
    model: 'demo-openai',
    status: 200,
    streamed: true,
    ttfbMs: 120,
    durationMs: 900,
    bytesIn: 512,
    bytesOut: 4096,
    usage: { prompt_tokens: 40, completion_tokens: 120, total_tokens: 160 },
    ...overrides,
  };
}

describe('RingBuffer', () => {
  it('keeps the newest values and reports a stable snapshot', () => {
    const buffer = new RingBuffer<number>(3);
    for (const value of [1, 2, 3, 4, 5]) buffer.push(value);
    expect(buffer.snapshot()).toEqual([3, 4, 5]);
    expect(buffer.size).toBe(3);
    expect(buffer.totalWritten).toBe(5);
    const snapshot = buffer.snapshot();
    buffer.push(6);
    expect(snapshot).toEqual([3, 4, 5]);
    expect(buffer.snapshot()).toEqual([4, 5, 6]);
  });

  it('computes nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 0.99)).toBe(99);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('Metrics', () => {
  it('counts requests, tokens, bytes and percentiles', () => {
    const metrics = new Metrics();
    for (let index = 0; index < 10; index += 1) {
      metrics.record(record({ durationMs: 100 * (index + 1) }));
    }
    const summary = metrics.summary();

    expect(summary.counters.requestsTotal).toBe(10);
    expect(summary.counters.requestsSuccess).toBe(10);
    expect(summary.counters.streams).toBe(10);
    expect(summary.counters.bytesOut).toBe(40_960);
    expect(summary.counters.tokensCompletion).toBe(1200);
    expect(summary.counters.tokensPrompt).toBe(400);
    expect(summary.latency.p50).toBeGreaterThan(0);
    expect(summary.latency.p99).toBeGreaterThanOrEqual(summary.latency.p50 ?? 0);
    expect(summary.byEndpoint['/v1/chat/completions']).toBe(10);
    expect(summary.byModel[0]?.model).toBe('demo-openai');
    expect(summary.byModel[0]?.requests).toBe(10);
  });

  it('tracks errors, status breakdown and the last error message', () => {
    const metrics = new Metrics();
    metrics.record(record());
    metrics.record(
      record({
        status: 502,
        error: { code: 'upstream_unavailable', message: 'upstream refused the connection' },
      }),
    );
    const summary = metrics.summary();

    expect(summary.counters.requestsError).toBe(1);
    expect(summary.byStatus['200']).toBe(1);
    expect(summary.byStatus['502']).toBe(1);
    expect(summary.lastError?.status).toBe(502);
    expect(summary.lastError?.message).toContain('refused');
    expect(metrics.errorList(10).items[0]?.status).toBe(502);
  });

  it('correlates panel and relay records so nothing is counted twice', () => {
    const metrics = new Metrics();
    metrics.record(record({ requestId: 'req-1' }));
    metrics.recordRelayAccess({
      method: 'POST',
      path: '/v1/chat/completions',
      status: 200,
      durationMs: 910,
      model: 'demo-openai',
      stream: true,
      at: null,
      requestId: 'req-1',
    });
    // Panel record + relay mirror of the same call ⇒ one request.
    expect(metrics.summary().counters.requestsTotal).toBe(1);

    metrics.recordRelayAccess({
      method: 'POST',
      path: '/v1/chat/completions',
      status: 200,
      durationMs: 300,
      model: 'demo-openai',
      stream: false,
      at: null,
      requestId: null,
    });
    // Traffic that bypassed the panel is still counted.
    expect(metrics.summary().counters.requestsTotal).toBe(2);
  });

  it('builds a bucketed time series and downsamples long ranges', () => {
    const metrics = new Metrics();
    for (let index = 0; index < 30; index += 1) {
      metrics.record(record({ durationMs: 50 + index }));
    }
    const hour = metrics.timeseries('1h');
    expect(hour.points.length).toBeGreaterThan(0);
    expect(hour.totals.requests).toBe(30);
    expect(hour.points[0]?.requests).toBe(30);
    expect(hour.points[0]?.p95).toBeGreaterThan(0);

    const day = metrics.timeseries('24h');
    expect(day.totals.requests).toBe(30);
  });

  it('reports rates from the trailing window', () => {
    const metrics = new Metrics();
    for (let index = 0; index < 5; index += 1) metrics.record(record());
    const summary = metrics.summary();
    expect(summary.rates.perMinute).toBe(5);
    expect(summary.rates.successRate).toBe(100);
  });

  it('tracks active streams and clears buffers on request', () => {
    const metrics = new Metrics();
    metrics.streamOpened();
    metrics.streamOpened();
    expect(metrics.summary().activeStreams).toBe(2);
    metrics.streamClosed();
    expect(metrics.summary().activeStreams).toBe(1);

    metrics.record(record());
    metrics.clear({ metrics: true, errors: true });
    const summary = metrics.summary();
    expect(summary.counters.requestsTotal).toBe(0);
    expect(summary.activeStreams).toBe(0);
    expect(summary.byModel).toHaveLength(0);
  });

  it('persists and restores counters across a restart', async () => {
    const first = new Metrics();
    first.record(record());
    first.record(record({ status: 500, error: { code: 'internal_error', message: 'boom' } }));
    await first.flush(true);

    const restored = new Metrics();
    await restored.hydrate();
    const summary = restored.summary();
    expect(summary.counters.requestsTotal).toBe(2);
    expect(summary.counters.requestsError).toBe(1);
    expect(summary.byModel[0]?.model).toBe('demo-openai');

    // Buffers themselves are intentionally not persisted.
    expect(summary.buffers.buckets).toBe(0);
  });

  it('is a process-wide singleton', () => {
    const a = getMetrics();
    const b = getMetrics();
    expect(a).toBe(b);
  });
});

describe('relay log parsing', () => {
  it('parses an access record with model, duration and correlation id', () => {
    const parsed = parseRelayLine(
      '[pol-relay] 2026-10-07T15:33:20Z POST /v1/chat/completions 200 model=openai-fast 812ms stream=true rid=abc-123',
    );
    expect(parsed.request).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions',
      status: 200,
      durationMs: 812,
      model: 'openai-fast',
      stream: true,
      requestId: 'abc-123',
    });
    expect(parsed.level).toBe('info');
  });

  it('classifies errors and ignores non-access lines', () => {
    expect(parseRelayLine('[pol-relay] ERROR upstream request failed: timed out').level).toBe('error');
    expect(parseRelayLine('[pol-relay] 500 Internal Server Error').request).toBeNull();
    expect(
      parseRelayLine('[pol-relay] 2026-10-07T15:33:20Z GET /v1/models 404 4ms').level,
    ).toBe('warn');
  });

  it('feeds relay access records into the metrics', () => {
    const metrics = getMetrics();
    const bus = new LogBus({ maxFileBytes: 0 });
    bus.subscribe((entry) => {
      if (entry.request) {
        metrics.recordRelayAccess({ ...entry.request, at: entry.at, requestId: null });
      }
    });
    bus.ingest('relay', '[pol-relay] 2026-10-07T15:33:20Z POST /v1/chat/completions 200 model=x 120ms stream=true\n');
    expect(getMetrics().summary().relay.requestsObserved).toBe(1);
  });
});

describe('LogBus', () => {
  it('keeps a bounded ring, filters and paginates', () => {
    const bus = new LogBus({ capacity: 5, maxFileBytes: 0 });
    bus.ingest('relay', 'line one\nline two\n');
    bus.push({ source: 'panel', level: 'error', message: 'panel exploded' });

    expect(bus.bufferSize).toBe(3);
    const page = bus.read({ limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries[page.entries.length - 1]?.message).toContain('panel exploded');

    const errors = bus.read({ level: 'error' });
    expect(errors.entries).toHaveLength(1);

    const searched = bus.read({ q: 'two' });
    expect(searched.entries).toHaveLength(1);

    const regex = bus.read({ q: '^line', regex: true });
    expect(regex.entries).toHaveLength(2);

    const older = bus.read({ cursor: String(page.entries[0]!.id) });
    expect(older.entries).toHaveLength(1);
  });

  it('redacts secrets before they reach the buffer', () => {
    const bus = new LogBus({ capacity: 10, maxFileBytes: 0 });
    bus.push({ source: 'system', message: 'using Authorization: Bearer sk-supersecretvalue123' });
    expect(bus.snapshot()[0]?.message).not.toContain('sk-supersecretvalue123');
  });
});
