import { NextResponse } from 'next/server';
import type { ApiEnvelope, ApiErrorCode } from '@/lib/types';
import { ensureBootstrapped } from './bootstrap';
import { env } from './env';
import { getLogBus } from './log-bus';
import { redactText } from './redact';
import { RelayLifecycleError } from './relay-manager';
import { RelayUnavailableError } from './upstream';

/**
 * Uniform response envelope + error translation for every route handler.
 *
 * Every endpoint answers with `{ ok: true, data }` or
 * `{ ok: false, error: { code, message, details? } }`, and every failure is
 * written to the log bus so the dashboard can surface it.
 */

export class ApiHttpError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'ApiHttpError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  relay_unavailable: 503,
  upstream_unavailable: 502,
  internal_error: 500,
};

export function ok<T>(data: T, init?: ResponseInit): NextResponse<ApiEnvelope<T>> {
  return NextResponse.json<ApiEnvelope<T>>({ ok: true, data }, init);
}

export function fail(
  code: ApiErrorCode | string,
  message: string,
  status?: number,
  details?: unknown,
): NextResponse<ApiEnvelope<never>> {
  const resolvedStatus = status ?? STATUS_BY_CODE[code] ?? 400;
  return NextResponse.json<ApiEnvelope<never>>(
    { ok: false, error: { code: code as ApiErrorCode, message: redactText(message), details } },
    { status: resolvedStatus },
  );
}

export interface RouteContext<P = Record<string, never>> {
  request: Request;
  params: P;
  /** Correlation id echoed to the client and used in log records. */
  requestId: string;
  startedAt: number;
}

type Handler<P> = (context: RouteContext<P>) => Promise<Response> | Response;

/**
 * Wraps a handler: generates a correlation id, times the request, logs it and
 * converts thrown errors into the standard envelope.
 */
export function route<P = Record<string, never>>(
  handler: Handler<P>,
  options: { logAccess?: boolean; label?: string } = {},
) {
  const { logAccess = true, label } = options;
  return async (request: Request, context?: { params?: P }): Promise<Response> => {
    await ensureBootstrapped();
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const routeContext: RouteContext<P> = {
      request,
      params: (context?.params ?? ({} as P)) as P,
      requestId,
      startedAt,
    };

    const respond = (response: Response): Response => {
      response.headers.set('x-request-id', requestId);
      if (logAccess) {
        const status = response.status;
        getLogBus().push({
          source: 'access',
          level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
          message: `${request.method} ${url.pathname} ${status} ${Date.now() - startedAt}ms${
            label ? ` (${label})` : ''
          }`,
          request: {
            method: request.method,
            path: url.pathname,
            status,
            durationMs: Date.now() - startedAt,
            model: null,
            stream: null,
          },
        });
      }
      return response;
    };

    try {
      const response = await handler(routeContext);
      return respond(response);
    } catch (error) {
      const response = translateError(error, requestId, url.pathname);
      return respond(response);
    }
  };
}

function translateError(error: unknown, requestId: string, path: string): NextResponse<ApiEnvelope<never>> {
  if (error instanceof ApiHttpError) {
    if (error.status >= 500) {
      getLogBus().push({
        source: 'system',
        level: 'error',
        message: `${path} failed: ${error.message} (${error.code})`,
      });
    }
    return fail(error.code, error.message, error.status, error.details);
  }

  if (error instanceof RelayLifecycleError) {
    const status =
      error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403 : error.code === 'port_in_use' ? 409 : 500;
    return fail(error.code as ApiErrorCode, error.message, status, error.details);
  }

  if (error instanceof RelayUnavailableError) {
    return fail('relay_unavailable', error.message, 503);
  }

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  getLogBus().push({
    source: 'system',
    level: 'error',
    message: `Unhandled error in ${path}: ${message}${stack ? `\n${stack.split('\n').slice(0, 4).join('\n')}` : ''}`,
  });
  return fail('internal_error', message, 500, { requestId });
}

/* ── request helpers ──────────────────────────────────────────────────────── */

export async function readJsonBody<T>(request: Request, maxBytes = env.chatMaxBodyBytes): Promise<T> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader) {
    const length = Number.parseInt(lengthHeader, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new ApiHttpError('bad_request', `Request body exceeds ${maxBytes} bytes.`, 413);
    }
  }
  const text = await request.text();
  if (text.length === 0) {
    throw new ApiHttpError('bad_request', 'Request body must be JSON.', 400);
  }
  if (text.length > maxBytes) {
    throw new ApiHttpError('bad_request', `Request body exceeds ${maxBytes} bytes.`, 413);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiHttpError('bad_request', 'Request body is not valid JSON.', 400);
  }
}

export function clientIp(request: Request): string {
  if (env.trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]!.trim();
    const real = request.headers.get('x-real-ip');
    if (real) return real.trim();
  }
  return request.headers.get('x-real-ip') ?? '127.0.0.1';
}

/** SSE response helper with the right headers for long-lived streams. */
export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

export function encodeSse(event: string, data: unknown, id?: number): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${payload}\n\n`;
}

export function errorCodeFor(error: unknown): ApiErrorCode {
  if (error instanceof ApiHttpError) return error.code;
  if (error instanceof RelayUnavailableError) return 'relay_unavailable';
  return 'internal_error';
}
