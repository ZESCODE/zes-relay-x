/**
 * Hand-rolled Server-Sent Events parser + streaming chat client.
 *
 * `EventSource` cannot issue POST requests, so the playground drives the
 * response body with `fetch` + `ReadableStream` and parses SSE by hand.
 * The parser follows the WHATWG event-stream rules: multi-line `data` fields
 * are joined with "\n", comment lines start with ":", CR / LF / CRLF all
 * terminate a line, and the last event is dispatched by a blank line or by the
 * end of the stream.
 */

export interface SseEvent {
  /** `event:` field, defaults to "message". */
  event: string;
  /** Joined `data:` payload. */
  data: string;
  id: string | null;
  retry: number | null;
}

export interface SseParser {
  push(chunk: string): SseEvent[];
  flush(): SseEvent[];
}

/**
 * Incremental SSE parser. Feed it decoded text chunks, receive complete events.
 */
export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | null = null;
  let lastId: string | null = null;
  let retry: number | null = null;
  let sawField = false;

  const reset = (): void => {
    dataLines = [];
    eventName = null;
    sawField = false;
  };

  const dispatch = (out: SseEvent[]): void => {
    if (!sawField) {
      // A newline with no fields — nothing to dispatch.
      reset();
      return;
    }
    if (dataLines.length > 0) {
      out.push({
        event: eventName ?? 'message',
        data: dataLines.join('\n'),
        id: lastId,
        retry,
      });
    }
    reset();
  };

  const handleLine = (line: string, out: SseEvent[]): void => {
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) {
      // Comment / keep-alive — ignored per spec.
      return;
    }
    sawField = true;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) lastId = value;
        break;
      case 'retry': {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 0) retry = parsed;
        break;
      }
      default:
        // Unknown field names are ignored, but they still count as a field so
        // that a blank line results in a dispatch attempt.
        break;
    }
  };

  return {
    push(chunk: string): SseEvent[] {
      const out: SseEvent[] = [];
      buffer += chunk;
      let index = buffer.search(/\r\n|\r|\n/);
      while (index !== -1) {
        const line = buffer.slice(0, index);
        const terminatorLength = buffer.startsWith('\r\n', index) ? 2 : 1;
        buffer = buffer.slice(index + terminatorLength);
        handleLine(line, out);
        index = buffer.search(/\r\n|\r|\n/);
      }
      return out;
    },
    flush(): SseEvent[] {
      const out: SseEvent[] = [];
      if (buffer.length > 0) {
        handleLine(buffer, out);
        buffer = '';
      }
      // Dispatch any trailing event that was not terminated by a blank line.
      if (dataLines.length > 0) {
        out.push({ event: eventName ?? 'message', data: dataLines.join('\n'), id: lastId, retry });
      }
      reset();
      return out;
    },
  };
}

/** Async iterator over the SSE events of a byte stream. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = createSseParser();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        yield event;
      }
    }
    for (const event of parser.push(decoder.decode())) yield event;
    for (const event of parser.flush()) yield event;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * OpenAI-compatible streaming shapes
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ChatCompletionChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: { role?: string; content?: string | null; reasoning_content?: string | null };
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
    text?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  error?: { message?: string; code?: string | number; type?: string } | string;
}

export interface ChatStreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatStreamResult {
  requestId: string;
  model: string;
  finishReason: string | null;
  usage: ChatStreamUsage | null;
  ttfbMs: number | null;
  totalMs: number;
  bytes: number;
  chunks: number;
  status: number;
}

export interface ChatStreamHandlers {
  /** Called once the response headers are available (before any token). */
  onOpen?: (info: { status: number; at: number }) => void;
  /** Incremental content. */
  onDelta?: (content: string, meta: { chunks: number; ttfbMs: number | null }) => void;
  /** Reasoning/thinking deltas, when the upstream provides them. */
  onReasoning?: (content: string) => void;
  /** Raw provider event payloads (used by the raw-response pane). */
  onEvent?: (event: SseEvent) => void;
  /** Resolves when the stream terminates cleanly. */
  onDone?: (result: ChatStreamResult) => void;
  /** Network/parse failures. */
  onError?: (error: Error) => void;
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  csrfToken?: string;
  /** Overrides fetch (tests). */
  fetchImpl?: typeof fetch;
}

function extractError(chunk: ChatCompletionChunk): string | null {
  if (!chunk.error) return null;
  if (typeof chunk.error === 'string') return chunk.error;
  return chunk.error.message ?? chunk.error.type ?? 'upstream error';
}

/**
 * POST a chat completion and stream the parse result through the handlers.
 * Returns the final result (also delivered through `onDone`).
 */
export async function streamChatCompletion(
  payload: Record<string, unknown>,
  handlers: ChatStreamHandlers = {},
  options: ChatStreamOptions = {},
): Promise<ChatStreamResult> {
  const startedAt = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.csrfToken) headers['x-csrf-token'] = options.csrfToken;

  let response: Response;
  try {
    response = await fetchImpl('/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    handlers.onError?.(err);
    throw err;
  }

  if (!response.ok) {
    const message = await readErrorEnvelope(response);
    const err = new Error(message);
    handlers.onError?.(err);
    throw err;
  }

  const status = response.status;
  handlers.onOpen?.({ status, at: startedAt });

  let ttfbMs: number | null = null;
  let chunks = 0;
  let bytes = 0;
  let finishReason: string | null = null;
  let usage: ChatStreamUsage | null = null;
  let requestId = '';
  let model = '';
  const contentType = response.headers.get('content-type') ?? '';

  // Non-streaming responses (stream: false) are a single JSON object.
  if (!contentType.includes('text/event-stream')) {
    const raw = await response.text();
    bytes = new TextEncoder().encode(raw).length;
    try {
      const envelopeOrChunk = JSON.parse(raw) as
        | (ChatCompletionChunk & { id?: string; model?: string })
        | { ok: true; data: ChatCompletionChunk }
        | { ok: false; error?: { message?: string } };
      // The panel wraps relay responses in its standard envelope.
      let json: ChatCompletionChunk & { id?: string; model?: string };
      if (typeof envelopeOrChunk === 'object' && envelopeOrChunk !== null && 'ok' in envelopeOrChunk) {
        if (envelopeOrChunk.ok === false) {
          throw new Error(envelopeOrChunk.error?.message ?? 'Chat request failed');
        }
        json = envelopeOrChunk.data as ChatCompletionChunk & { id?: string; model?: string };
      } else {
        json = envelopeOrChunk as ChatCompletionChunk & { id?: string; model?: string };
      }
      requestId = json.id ?? '';
      model = json.model ?? '';
      usage = normalizeUsage(json.usage ?? null);
      finishReason = json.choices?.[0]?.finish_reason ?? null;
      const content = json.choices?.[0]?.message?.content ?? '';
      if (content) {
        ttfbMs = Date.now() - startedAt;
        handlers.onDelta?.(content, { chunks: 1, ttfbMs });
      }
      const upstreamError = extractError(json);
      if (upstreamError) throw new Error(upstreamError);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      handlers.onError?.(err);
      throw err;
    }
    const result: ChatStreamResult = {
      requestId,
      model,
      finishReason,
      usage,
      ttfbMs: ttfbMs ?? Date.now() - startedAt,
      totalMs: Date.now() - startedAt,
      bytes,
      chunks: 1,
      status,
    };
    handlers.onDone?.(result);
    return result;
  }

  if (!response.body) {
    const err = new Error('Response contained no body to stream');
    handlers.onError?.(err);
    throw err;
  }

  try {
    for await (const event of parseSseStream(response.body, options.signal)) {
      handlers.onEvent?.(event);
      bytes += event.data.length;
      if (event.data === '[DONE]') break;
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(event.data) as ChatCompletionChunk;
      } catch {
        continue; // Ignore keep-alive/garbage lines instead of killing the stream.
      }
      const upstreamError = extractError(chunk);
      if (upstreamError) throw new Error(upstreamError);
      if (chunk.id) requestId = chunk.id;
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = normalizeUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const reasoning = choice?.delta?.reasoning_content;
      if (reasoning) handlers.onReasoning?.(reasoning);
      const delta = choice?.delta?.content ?? choice?.text ?? '';
      if (delta) {
        chunks += 1;
        if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
        handlers.onDelta?.(delta, { chunks, ttfbMs });
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    handlers.onError?.(err);
    throw err;
  }

  const result: ChatStreamResult = {
    requestId,
    model,
    finishReason,
    usage,
    ttfbMs,
    totalMs: Date.now() - startedAt,
    bytes,
    chunks,
    status,
  };
  handlers.onDone?.(result);
  return result;
}

function normalizeUsage(
  usage: ChatCompletionChunk['usage'] | undefined,
): ChatStreamUsage | null {
  if (!usage) return null;
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens:
      usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  };
}

/** Reads `{ ok:false, error:{ message } }` envelopes from failed responses. */
export async function readErrorEnvelope(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `Request failed with status ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      return (
        parsed.error?.message ??
        parsed.message ??
        `Request failed with status ${response.status}`
      );
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return `Request failed with status ${response.status}`;
  }
}
