'use client';

/**
 * Typed fetch client for the panel API.
 *
 * - unwraps the `{ ok, data | error }` envelope
 * - attaches the double-submit CSRF header for state-changing verbs
 * - never touches localStorage (session state lives in httpOnly cookies)
 */

import type {
  ApiEnvelope,
  ApiErrorCode,
  ApiToken,
  ApiTokenWithSecret,
  BackupEntry,
  ChatPreset,
  ChatParams,
  ChatMessage,
  ConfigDocument,
  ConfigKey,
  ConfigValidationResult,
  LogLevel,
  LogQuery,
  LogSource,
  LogsPage,
  MeResponse,
  MetricsErrors,
  MetricsSummary,
  MetricsTimeseries,
  MetricRange,
  ModelInfo,
  ModelsResponse,
  RelayStatus,
  ResetResult,
  SystemInfo,
  ThemeName,
  TokenScope,
} from './types';

export class ApiClientError extends Error {
  readonly code: ApiErrorCode | 'network_error';
  readonly status: number;
  readonly details: unknown;

  constructor(
    message: string,
    code: ApiErrorCode | 'network_error',
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const CSRF_COOKIE = 'zes_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const target = `${name}=`;
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(target)) return decodeURIComponent(part.slice(target.length));
  }
  return null;
}

export function csrfToken(): string | undefined {
  return readCookie(CSRF_COOKIE) ?? undefined;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Skip CSRF header (only used by the login route which has no cookie yet). */
  skipCsrf?: boolean;
  headers?: Record<string, string>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && !options.skipCsrf) {
    const token = csrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError(
      error instanceof Error ? error.message : 'Network request failed',
      'network_error',
      0,
    );
  }

  const text = await response.text();
  let envelope: ApiEnvelope<T> | null = null;
  if (text) {
    try {
      envelope = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      envelope = null;
    }
  }

  if (!envelope) {
    if (response.ok) return undefined as T;
    throw new ApiClientError(
      text.slice(0, 500) || `Request failed with status ${response.status}`,
      'internal_error',
      response.status,
    );
  }

  if (envelope.ok) return envelope.data;

  const err = new ApiClientError(
    envelope.error.message,
    envelope.error.code,
    response.status,
    envelope.error.details,
  );
  throw err;
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/* ── auth ────────────────────────────────────────────────────────────────── */

export function fetchMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/me');
}

export function login(username: string, password: string): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
    skipCsrf: true,
  });
}

export function logout(): Promise<{ loggedOut: boolean }> {
  return request<{ loggedOut: boolean }>('/api/auth/logout', { method: 'POST' });
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ changed: boolean }> {
  return request<{ changed: boolean }>('/api/auth/password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}

export function setTheme(theme: ThemeName): Promise<{ theme: ThemeName }> {
  return request<{ theme: ThemeName }>('/api/theme', { method: 'POST', body: { theme } });
}

/* ── relay lifecycle ─────────────────────────────────────────────────────── */

export function fetchRelayStatus(signal?: AbortSignal): Promise<RelayStatus> {
  return request<RelayStatus>('/api/relay/status', { signal });
}

export function startRelay(): Promise<RelayStatus> {
  return request<RelayStatus>('/api/relay/start', { method: 'POST' });
}

export function stopRelay(force = false, confirmToken?: string): Promise<RelayStatus> {
  return request<RelayStatus>('/api/relay/stop', {
    method: 'POST',
    body: { force, confirmToken },
  });
}

export function restartRelay(): Promise<RelayStatus> {
  return request<RelayStatus>('/api/relay/restart', { method: 'POST' });
}

export function probeRelayHealth(): Promise<{
  ok: boolean;
  running: boolean;
  latencyMs: number | null;
  status: number | null;
  error: string | null;
  checkedAt: string;
  models: number | null;
}> {
  return request('/api/relay/health', { method: 'POST' });
}

/* ── metrics ─────────────────────────────────────────────────────────────── */

export function fetchMetricsSummary(signal?: AbortSignal): Promise<MetricsSummary> {
  return request<MetricsSummary>('/api/metrics/summary', { signal });
}

export function fetchTimeseries(range: MetricRange, signal?: AbortSignal): Promise<MetricsTimeseries> {
  return request<MetricsTimeseries>(`/api/metrics/timeseries${qs({ range })}`, { signal });
}

export function fetchModelMetrics(signal?: AbortSignal): Promise<{ models: MetricsSummary['byModel'] }> {
  return request<{ models: MetricsSummary['byModel'] }>('/api/metrics/models', { signal });
}

export function fetchErrors(
  limit = 50,
  signal?: AbortSignal,
): Promise<MetricsErrors> {
  return request<MetricsErrors>(`/api/metrics/errors${qs({ limit })}`, { signal });
}

/* ── models ──────────────────────────────────────────────────────────────── */

export function fetchModels(refresh = false, signal?: AbortSignal): Promise<ModelsResponse> {
  return request<ModelsResponse>(`/api/models${qs({ refresh })}`, { signal });
}

/* ── logs ────────────────────────────────────────────────────────────────── */

export function fetchLogs(
  query: LogQuery = {},
  signal?: AbortSignal,
): Promise<LogsPage> {
  const params: Record<string, string | number | boolean | undefined> = {
    limit: query.limit,
    cursor: query.cursor,
    level: query.level === 'all' ? undefined : query.level,
    source: query.source === 'all' ? undefined : query.source,
    q: query.q,
    regex: query.regex ? 'true' : undefined,
    sinceMs: query.sinceMs,
  };
  return request<LogsPage>(`/api/logs${qs(params)}`, { signal });
}

export function logsDownloadUrl(filters: {
  level?: LogLevel | 'all';
  source?: LogSource | 'all';
  q?: string;
  regex?: boolean;
} = {}): string {
  return `/api/logs/download${qs({
    level: filters.level === 'all' ? undefined : filters.level,
    source: filters.source === 'all' ? undefined : filters.source,
    q: filters.q,
    regex: filters.regex ? 'true' : undefined,
  })}`;
}

/* ── presets ─────────────────────────────────────────────────────────────── */

export interface PresetInput {
  name: string;
  params: ChatParams;
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>;
}

export function fetchPresets(signal?: AbortSignal): Promise<{ presets: ChatPreset[] }> {
  return request<{ presets: ChatPreset[] }>('/api/chat/presets', { signal });
}

export function fetchPreset(id: string): Promise<{ preset: ChatPreset }> {
  return request<{ preset: ChatPreset }>(`/api/chat/presets/${encodeURIComponent(id)}`);
}

export function createPreset(input: PresetInput): Promise<{ preset: ChatPreset }> {
  return request<{ preset: ChatPreset }>('/api/chat/presets', { method: 'POST', body: input });
}

export function deletePreset(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/chat/presets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/* ── config ──────────────────────────────────────────────────────────────── */

export function fetchConfig(signal?: AbortSignal): Promise<ConfigDocument> {
  return request<ConfigDocument>('/api/config', { signal });
}

export function saveConfig(values: Partial<Record<ConfigKey, string>>, restart = false) {
  return request<{ saved: boolean; dirty: ConfigKey[]; restarted: boolean; relay: RelayStatus | null }>(
    '/api/config',
    { method: 'PUT', body: { values, restart } },
  );
}

export function validateConfig(
  values: Partial<Record<ConfigKey, string>>,
  probe = false,
): Promise<ConfigValidationResult> {
  return request<ConfigValidationResult>('/api/config/validate', {
    method: 'POST',
    body: { values, probe },
  });
}

export function revealConfigKey(key: ConfigKey): Promise<{ key: ConfigKey; value: string }> {
  return request<{ key: ConfigKey; value: string }>('/api/config/reveal', {
    method: 'POST',
    body: { key },
  });
}

/* ── admin ───────────────────────────────────────────────────────────────── */

export function listTokens(): Promise<{ tokens: ApiToken[] }> {
  return request<{ tokens: ApiToken[] }>('/api/admin/tokens');
}

export function createToken(input: {
  name: string;
  scopes: TokenScope[];
  expiresInDays?: number | null;
}): Promise<ApiTokenWithSecret> {
  return request<ApiTokenWithSecret>('/api/admin/tokens', { method: 'POST', body: input });
}

export function revokeToken(id: string): Promise<{ token: ApiToken }> {
  return request<{ token: ApiToken }>(`/api/admin/tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function listBackups(): Promise<{ backups: BackupEntry[]; totalBytes: number }> {
  return request<{ backups: BackupEntry[]; totalBytes: number }>('/api/admin/backup');
}

export function createBackup(includeSecrets = false): Promise<{ backup: BackupEntry }> {
  return request<{ backup: BackupEntry }>('/api/admin/backup', {
    method: 'POST',
    body: { includeSecrets },
  });
}

export function backupDownloadUrl(id: string): string {
  return `/api/admin/backup/${encodeURIComponent(id)}`;
}

export function resetData(targets: {
  metrics: boolean;
  logs: boolean;
  events: boolean;
  errors: boolean;
  presets?: boolean;
}): Promise<ResetResult> {
  return request<ResetResult>('/api/admin/reset', { method: 'POST', body: targets });
}

export function fetchSystemInfo(): Promise<SystemInfo> {
  return request<SystemInfo>('/api/admin/system');
}

export function exportSettings(includeSecrets = false): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    `/api/admin/export${qs({ secrets: includeSecrets ? 'true' : undefined })}`,
  );
}

export function importSettings(
  payload: Record<string, unknown>,
  options: { restart?: boolean } = {},
) {
  return request<{ imported: string[]; skipped: string[]; restarted: boolean }>(
    '/api/admin/import',
    { method: 'POST', body: { payload, restart: options.restart ?? false } },
  );
}

/** Convenience wrapper used by the dashboard model table. */
export function fetchModelMetricsTable(): Promise<{ models: MetricsSummary['byModel'] }> {
  return fetchModelMetrics();
}

export type { ModelInfo };
