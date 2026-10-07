/**
 * Shared types for the ZES Relay Control Panel.
 *
 * These types are imported by both server and client modules, therefore they
 * must stay free of any runtime dependency (types only).
 */

/* ────────────────────────────────────────────────────────────────────────────
 * API envelope — every route answers with one of these shapes.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'relay_unavailable'
  | 'validation_failed'
  | 'internal_error';

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiFail {
  ok: false;
  error: ApiErrorBody;
}

export type ApiEnvelope<T> = ApiOk<T> | ApiFail;

/* ────────────────────────────────────────────────────────────────────────────
 * Design tokens
 * ──────────────────────────────────────────────────────────────────────────── */

export type FrostColor = 'green' | 'blue' | 'orange' | 'red';

/* ────────────────────────────────────────────────────────────────────────────
 * Auth
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SessionUser {
  username: string;
  role: 'admin';
  createdAt: string;
  mustChangePassword: boolean;
}

export interface MeResponse {
  authenticated: boolean;
  user: SessionUser | null;
  via: 'session' | 'token' | null;
  tokenName?: string;
  csrfToken: string;
  theme: ThemeName;
  panelVersion: string;
}

export type ThemeName = 'dark' | 'light';

/* ────────────────────────────────────────────────────────────────────────────
 * Relay lifecycle
 * ──────────────────────────────────────────────────────────────────────────── */

export type RelayState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed';

export type LifecycleEventKind =
  | 'start_requested'
  | 'spawned'
  | 'adopted'
  | 'exited'
  | 'stopped'
  | 'killed'
  | 'restart_scheduled'
  | 'restart_exhausted'
  | 'health_up'
  | 'health_down'
  | 'error';

export interface LifecycleEvent {
  at: string;
  kind: LifecycleEventKind;
  message: string;
  pid?: number | null;
  detail?: Record<string, unknown>;
}

export interface RelayRuntimeConfig {
  /** Port the relay listens on (data/.env: POL_RELAY_PORT). */
  port: number;
  /** Upstream base URL the relay proxies to (POL_UPSTREAM_BASE). */
  upstreamBase: string;
  /** Whether the relay injects POL_API_KEY (false) or forwards client auth (true). */
  skipAuth: boolean;
  /** Whether an upstream key is present — the value itself is never exposed. */
  hasApiKey: boolean;
  /** Absolute path of the script the manager executes. */
  script: string;
  pythonBin: string;
}

export interface RelayStatus {
  state: RelayState;
  /** True when the relay answered the last health probe. */
  running: boolean;
  healthy: boolean;
  /** True when the panel spawned the process and may terminate it. */
  owned: boolean;
  pid: number | null;
  port: number;
  baseUrl: string;
  script: string | null;
  scriptSha256: string | null;
  startedAt: string | null;
  uptimeMs: number | null;
  restarts: number;
  consecutiveFailures: number;
  lastHealthAt: string | null;
  lastHealthLatencyMs: number | null;
  lastError: { at: string; message: string } | null;
  /** Idempotency flag used by POST /api/relay/start. */
  alreadyRunning: boolean;
  externalProcess: {
    /** Non-null when the port is held by a process the panel does not own. */
    detected: boolean;
    pid: number | null;
    note: string;
  };
  config: RelayRuntimeConfig;
  events: LifecycleEvent[];
}

export interface HealthProbe {
  ok: boolean;
  latencyMs: number | null;
  at: string;
  status: number | null;
  modelCount: number | null;
  error: string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Metrics
 * ──────────────────────────────────────────────────────────────────────────── */

export type MetricRange = '15m' | '1h' | '6h' | '24h';

export interface MetricCounters {
  requestsTotal: number;
  requestsSuccess: number;
  requestsError: number;
  streams: number;
  streamsCompleted: number;
  streamsAborted: number;
  bytesIn: number;
  bytesOut: number;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensTotal: number;
  ttfbSumMs: number;
  latencySumMs: number;
  upstreamErrors: number;
  restarts: number;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg: number | null;
  max: number | null;
  last: number | null;
  lastTtfb: number | null;
}

export interface MetricsSummary {
  since: string;
  now: string;
  uptimeMs: number;
  counters: MetricCounters;
  rates: {
    /** Requests observed in the last 60 seconds. */
    perMinute: number;
    /** Requests observed in the last 5 seconds. */
    perSecond: number;
    errorsPerMinute: number;
    successRate: number | null;
  };
  activeStreams: number;
  latency: LatencySummary;
  byStatus: Record<string, number>;
  byEndpoint: Record<string, number>;
  byModel: ModelMetric[];
  lastError: { at: string; message: string; status: number | null; model: string | null } | null;
  relay: {
    requestsObserved: number;
    errorsObserved: number;
    parseWarnings: number;
  };
  buffers: {
    samples: number;
    buckets: number;
    errors: number;
    logs: number;
  };
}

export interface ModelMetric {
  model: string;
  requests: number;
  errors: number;
  streams: number;
  tokensPrompt: number;
  tokensCompletion: number;
  bytesIn: number;
  bytesOut: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  lastUsedAt: string | null;
}

export interface MetricsTimeseriesPoint {
  t: string;
  requests: number;
  errors: number;
  tokensPrompt: number;
  tokensCompletion: number;
  bytesOut: number;
  avgLatencyMs: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface MetricsTimeseries {
  range: MetricRange;
  bucketMs: number;
  from: string;
  to: string;
  points: MetricsTimeseriesPoint[];
  totals: {
    requests: number;
    errors: number;
    tokensPrompt: number;
    tokensCompletion: number;
    bytesOut: number;
  };
}

export interface MetricsErrors {
  total: number;
  items: ErrorEntry[];
}

export interface ErrorEntry {
  id: string;
  at: string;
  status: number;
  code: string;
  message: string;
  endpoint: string;
  model: string | null;
  requestId: string | null;
  source: 'panel' | 'relay';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Logs
 * ──────────────────────────────────────────────────────────────────────────── */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'panel' | 'relay' | 'access' | 'system';

export interface LogEntry {
  id: number;
  at: string;
  level: LogLevel;
  source: LogSource;
  /** Raw line, already redacted. */
  message: string;
  /** Set when the line was recognised as a relay access log record. */
  request?: {
    method: string;
    path: string;
    status: number;
    durationMs: number | null;
    model: string | null;
    stream: boolean | null;
    /** Echoed by the relay when the panel proxied the call (dedup key). */
    requestId?: string | null;
    /** Timestamp parsed off the relay line, when it carried one. */
    at?: string | null;
  } | null;
}

export interface LogsPage {
  entries: LogEntry[];
  /** Cursor for the next older page ("" when exhausted). */
  nextCursor: string;
  bufferStartId: number;
  bufferEndId: number;
  total: number;
}

export interface LogQuery {
  limit?: number;
  cursor?: string;
  level?: LogLevel | 'all';
  source?: LogSource | 'all';
  q?: string;
  regex?: boolean;
  sinceMs?: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Chat / playground
 * ──────────────────────────────────────────────────────────────────────────── */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

export interface ChatParams {
  model: string;
  temperature: number;
  top_p: number;
  max_tokens: number | null;
  presence_penalty: number;
  frequency_penalty: number;
  seed: number | null;
  stop: string[];
  stream: boolean;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResultMeta {
  requestId: string;
  model: string;
  streamed: boolean;
  ttfbMs: number | null;
  totalMs: number;
  usage: ChatUsage | null;
  finishReason: string | null;
  bytes: number;
  status: number;
}

export interface ChatPreset {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  params: ChatParams;
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Models
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ModelInfo {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  /** Optional extras some OpenAI-compatible servers return. */
  description?: string;
  [key: string]: unknown;
}

export interface ModelsResponse {
  models: ModelInfo[];
  fetchedAt: string;
  latencyMs: number | null;
  source: 'relay' | 'cache' | 'fallback';
  error: string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Config
 * ──────────────────────────────────────────────────────────────────────────── */

export type ConfigKey =
  | 'POL_RELAY_PORT'
  | 'POL_UPSTREAM_BASE'
  | 'POL_API_KEY'
  | 'POL_SKIP_AUTH';

export interface ConfigFieldState {
  key: ConfigKey;
  value: string;
  /** True when the persisted value is non-empty but withheld from the client. */
  masked: boolean;
  /** Value currently in effect for the running relay process ("" when unknown). */
  runningValue: string;
  isSecret: boolean;
  comment: string[];
}

export interface ConfigDocument {
  path: string;
  exists: boolean;
  fields: ConfigFieldState[];
  /** Lines preserved verbatim (comments, unrelated keys). */
  passthrough: number;
  dirty: ConfigKey[];
  updatedAt: string | null;
}

export interface ConfigValidationIssue {
  key: ConfigKey | 'file';
  level: 'error' | 'warning';
  message: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  issues: ConfigValidationIssue[];
  normalized: Partial<Record<ConfigKey, string>>;
  probe: {
    attempted: boolean;
    ok: boolean | null;
    status: number | null;
    latencyMs: number | null;
    message: string;
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Admin — tokens, backups, system
 * ──────────────────────────────────────────────────────────────────────────── */

export type TokenScope = 'read' | 'write' | 'admin';

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokenWithSecret {
  token: ApiToken;
  /** Present exactly once, on creation. */
  secret: string;
}

export interface BackupEntry {
  id: string;
  name: string;
  createdAt: string;
  bytes: number;
  files: number;
  containsSecrets: boolean;
}

export interface SystemInfo {
  panelVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  pid: number;
  pythonVersion: string | null;
  pythonBin: string;
  relayScript: string | null;
  relayScriptSha256: string | null;
  dataDir: string;
  dataDirSizeBytes: number;
  startedAt: string;
  uptimeMs: number;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  env: Array<{ key: string; value: string }>;
}

export interface ResetResult {
  cleared: string[];
  metrics: boolean;
  logs: boolean;
  events: boolean;
  errors: boolean;
}
