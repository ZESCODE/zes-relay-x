import { Buffer } from 'node:buffer';
import { guard } from '@/server/auth';
import { parseChatPayload, toUpstreamBody } from '@/server/chat-payload';
import { getConfigStore } from '@/server/config-store';
import { env } from '@/server/env';
import { ApiHttpError, fail, ok, readJsonBody, route } from '@/server/http';
import { getMetrics } from '@/server/metrics';
import { redactText } from '@/server/redact';
import { relayFetch } from '@/server/upstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENDPOINT = '/v1/chat/completions';

interface UsageTotals {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * POST /api/chat — the playground's (and any script's) door to the relay.
 *
 * True streaming: bytes are forwarded to the browser as they arrive, while a
 * side-channel parser accumulates `usage`, `finish_reason` and byte counts for
 * the metrics module. Nothing is buffered before the first token.
 */
export const POST = route(async ({ request, requestId }) => {
  await guard(request, { scope: 'write', rateLimit: 'chat' });

  const rawBody = await readJsonBody<unknown>(request, env.chatMaxBodyBytes);
  const payload = parseChatPayload(rawBody);
  const body = toUpstreamBody(payload);
  const serialized = JSON.stringify(body);
  const bytesIn = Buffer.byteLength(serialized, 'utf8');

  const values = await getConfigStore().readValues();
  const port = Number.parseInt(values.POL_RELAY_PORT, 10) || 7179;

  const metrics = getMetrics();
  const startedAt = Date.now();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  request.signal.addEventListener('abort', onAbort, { once: true });

  let upstream: Response;
  try {
    upstream = await relayFetch(port, ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: payload.params.stream ? 'text/event-stream' : 'application/json',
        'x-panel-request-id': requestId,
      },
      body: serialized,
      timeoutMs: payload.params.stream ? env.requestTimeoutMs : Math.min(env.requestTimeoutMs, 120_000),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    metrics.record({
      source: 'panel',
      endpoint: ENDPOINT,
      model: payload.model,
      status: 503,
      streamed: payload.params.stream,
      durationMs: Date.now() - startedAt,
      bytesIn,
      error: { code: 'relay_unavailable', message },
      requestId,
    });
    throw new ApiHttpError('relay_unavailable', `Relay unreachable: ${message}`, 503);
  }

  // ── error passthrough ────────────────────────────────────────────────────
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    const message = redactText(text.slice(0, 500) || `Relay responded with HTTP ${upstream.status}`);
    metrics.record({
      source: 'panel',
      endpoint: ENDPOINT,
      model: payload.model,
      status: upstream.status,
      streamed: payload.params.stream,
      durationMs: Date.now() - startedAt,
      bytesIn,
      bytesOut: Buffer.byteLength(text, 'utf8'),
      error: { code: `http_${upstream.status}`, message },
      requestId,
    });
    return fail(
      upstream.status >= 500 ? 'upstream_unavailable' : 'bad_request',
      message,
      upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
    );
  }

  // ── non-streaming completion ─────────────────────────────────────────────
  if (!payload.params.stream) {
    const text = await upstream.text();
    const bytesOut = Buffer.byteLength(text, 'utf8');
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const message = redactText(text.slice(0, 500) || 'Relay returned a non-JSON body');
      metrics.record({
        source: 'panel',
        endpoint: ENDPOINT,
        model: payload.model,
        status: 502,
        streamed: false,
        durationMs: Date.now() - startedAt,
        bytesIn,
        bytesOut,
        error: { code: 'upstream_unavailable', message },
        requestId,
      });
      return fail('upstream_unavailable', message, 502);
    }

    const completion = parsed as {
      usage?: UsageTotals | null;
      choices?: Array<{ finish_reason?: string | null }>;
      model?: string;
    };
    metrics.record({
      source: 'panel',
      endpoint: ENDPOINT,
      model: completion.model ?? payload.model,
      status: upstream.status,
      streamed: false,
      durationMs: Date.now() - startedAt,
      bytesIn,
      bytesOut,
      usage: completion.usage ?? null,
      requestId,
    });
    return ok(parsed);
  }

  // ── streaming completion ─────────────────────────────────────────────────
  if (!upstream.body) {
    metrics.record({
      source: 'panel',
      endpoint: ENDPOINT,
      model: payload.model,
      status: 502,
      streamed: true,
      durationMs: Date.now() - startedAt,
      bytesIn,
      error: { code: 'upstream_unavailable', message: 'Relay returned an empty stream' },
      requestId,
    });
    return fail('upstream_unavailable', 'Relay returned an empty stream body.', 502);
  }

  const decoder = new TextDecoder();
  let pending = '';
  let bytesOut = 0;
  let ttfbMs: number | null = null;
  let usage: UsageTotals | null = null;
  let finishReason: string | null = null;
  let upstreamModel = payload.model;
  let streamError: string | null = null;
  let closed = false;

  const inspect = (text: string): void => {
    pending += text;
    // Guard the accumulator: a malformed upstream must not grow unbounded.
    if (pending.length > 2_000_000) pending = pending.slice(-100_000);
    let boundary = pending.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      boundary = pending.indexOf('\n\n');
      if (!frame.trim() || frame.startsWith(':')) continue;
      const dataLine = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!dataLine || dataLine === '[DONE]') continue;
      try {
        const chunk = JSON.parse(dataLine) as {
          model?: string;
          usage?: UsageTotals | null;
          choices?: Array<{ finish_reason?: string | null }>;
          error?: { message?: string } | string;
        };
        if (chunk.model) upstreamModel = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const reason = chunk.choices?.[0]?.finish_reason;
        if (reason) finishReason = reason;
        if (chunk.error) {
          streamError =
            typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'upstream error');
        }
      } catch {
        // Partial/unknown frame — keep streaming, nothing to record yet.
      }
    }
  };

  const reader = upstream.body.getReader();
  const finalize = (aborted: boolean): void => {
    if (closed) return;
    closed = true;
    metrics.streamClosed();
    metrics.record({
      source: 'panel',
      endpoint: ENDPOINT,
      model: upstreamModel,
      status: aborted ? 499 : 200,
      streamed: true,
      durationMs: Date.now() - startedAt,
      ttfbMs,
      bytesIn,
      bytesOut,
      usage,
      error: aborted
        ? { code: 'client_closed', message: 'Client closed the stream before completion.' }
        : streamError
          ? { code: 'upstream_stream_error', message: streamError }
          : null,
      requestId,
    });
  };

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      metrics.streamOpened();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
          bytesOut += value.byteLength;
          streamController.enqueue(value);
          inspect(decoder.decode(value, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail) inspect(tail);
        inspect('\n\n');
        streamController.close();
        finalize(false);
      } catch (error) {
        if (cancelled) {
          finalize(true);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        streamError = redactText(message);
        try {
          streamController.error(error);
        } catch {
          /* already closed */
        }
        finalize(true);
      }
    },
    cancel() {
      cancelled = true;
      void reader.cancel().catch(() => undefined);
      finalize(true);
    },
  });

  request.signal.addEventListener('abort', () => {
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
      'x-relay-model': upstreamModel,
    },
  });
});
