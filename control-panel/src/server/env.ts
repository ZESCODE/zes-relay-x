/**
 * Environment access with documented defaults.
 *
 * Every knob the panel exposes is read through these helpers so the README can
 * stay authoritative and tests can override the environment in-place.
 */

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on', 'enabled']);

export function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

export function envOptional(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function envInt(
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = envOptional(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = bounds.min ?? Number.NEGATIVE_INFINITY;
  const max = bounds.max ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(parsed, min), max);
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = envOptional(name);
  if (raw === null) return fallback;
  return BOOL_TRUE.has(raw.toLowerCase());
}

export function envList(name: string): string[] {
  const raw = envOptional(name);
  if (raw === null) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Panel knobs resolved lazily so runtime env changes are honoured. */
export const env = {
  get host(): string {
    return envString('PANEL_HOST', '127.0.0.1');
  },
  get port(): number {
    return envInt('PANEL_PORT', 3000, { min: 1, max: 65535 });
  },
  get allowPublic(): boolean {
    return envBool('PANEL_ALLOW_PUBLIC', false);
  },
  get frameAncestors(): string {
    return envString('PANEL_FRAME_ANCESTORS', "'none'");
  },
  get embeddable(): boolean {
    return envBool('PANEL_EMBEDDABLE', false);
  },
  get dataDir(): string | null {
    return envOptional('PANEL_DATA_DIR');
  },
  get sessionSecret(): string | null {
    return envOptional('PANEL_SESSION_SECRET');
  },
  get sessionTtlHours(): number {
    return envInt('PANEL_SESSION_TTL_HOURS', 12, { min: 1, max: 24 * 30 });
  },
  get adminUser(): string {
    return envString('PANEL_ADMIN_USER', 'admin');
  },
  get adminPassword(): string | null {
    return envOptional('PANEL_ADMIN_PASSWORD');
  },
  /**
   * Cookie SameSite policy.
   *
   * `lax` is the right default for a loopback panel. Embedded previews (a
   * cross-site iframe) need `none`, which browsers only accept together with
   * `Secure` — cookieOptions() enforces that pairing.
   */
  get cookieSameSite(): 'lax' | 'strict' | 'none' {
    const raw = envString('PANEL_COOKIE_SAMESITE', 'lax').toLowerCase();
    return raw === 'strict' || raw === 'none' ? raw : 'lax';
  },
  get trustProxy(): boolean {
    return envBool('PANEL_TRUST_PROXY', false);
  },
  get relayScript(): string {
    return envString('PANEL_RELAY_SCRIPT', '../pol_relay.py');
  },
  get relayScriptFallback(): string {
    return envString('PANEL_RELAY_SCRIPT_FALLBACK', '../pol-relay.sh');
  },
  get pythonBin(): string {
    return envString('PANEL_PYTHON_BIN', 'python3');
  },
  get relayBearer(): string | null {
    return envOptional('PANEL_RELAY_BEARER');
  },
  get healthIntervalMs(): number {
    return envInt('PANEL_HEALTH_INTERVAL_MS', 5000, { min: 500, max: 600_000 });
  },
  get healthTimeoutMs(): number {
    return envInt('PANEL_HEALTH_TIMEOUT_MS', 2000, { min: 200, max: 60_000 });
  },
  get autoRestart(): number {
    return envInt('PANEL_AUTORESTART', 3, { min: 0, max: 50 });
  },
  get shutdownGraceMs(): number {
    return envInt('PANEL_SHUTDOWN_GRACE_MS', 5000, { min: 100, max: 60_000 });
  },
  get startTimeoutMs(): number {
    return envInt('PANEL_START_TIMEOUT_MS', 8000, { min: 500, max: 120_000 });
  },
  get restartBackoffMs(): number {
    return envInt('PANEL_RESTART_BACKOFF_MS', 1000, { min: 100, max: 60_000 });
  },
  get loginRateLimit(): number {
    return envInt('PANEL_LOGIN_RATE_LIMIT', 5, { min: 1, max: 10_000 });
  },
  get chatRateLimit(): number {
    return envInt('PANEL_CHAT_RATE_LIMIT', 60, { min: 1, max: 1_000_000 });
  },
  get rateWindowMs(): number {
    return envInt('PANEL_RATE_WINDOW_MS', 60_000, { min: 1000, max: 3_600_000 });
  },
  get maxLogEntries(): number {
    return envInt('PANEL_MAX_LOG_ENTRIES', 5000, { min: 100, max: 500_000 });
  },
  get metricsSamples(): number {
    return envInt('PANEL_METRICS_SAMPLES', 3600, { min: 60, max: 100_000 });
  },
  get metricsBuckets(): number {
    return envInt('PANEL_METRICS_BUCKETS', 1440, { min: 60, max: 20_000 });
  },
  get metricsStreamMs(): number {
    return envInt('PANEL_METRICS_STREAM_MS', 2000, { min: 500, max: 60_000 });
  },
  get metricsTickMs(): number {
    return envInt('PANEL_METRICS_TICK_MS', 5000, { min: 1000, max: 300_000 });
  },
  get panelLogMaxBytes(): number {
    return envInt('PANEL_PANEL_LOG_MAX_BYTES', 5 * 1024 * 1024, { min: 64 * 1024 });
  },
  get panelLogKeep(): number {
    return envInt('PANEL_PANEL_LOG_KEEP', 3, { min: 0, max: 20 });
  },
  get maxErrors(): number {
    return envInt('PANEL_MAX_ERRORS', 100, { min: 10, max: 10_000 });
  },
  get maxPresets(): number {
    return envInt('PANEL_MAX_PRESETS', 200, { min: 1, max: 10_000 });
  },
  get maxBackups(): number {
    return envInt('PANEL_MAX_BACKUPS', 50, { min: 1, max: 1000 });
  },
  get chatMaxBodyBytes(): number {
    return envInt('PANEL_CHAT_MAX_BODY_BYTES', 1024 * 1024, { min: 1024 });
  },
  get requestTimeoutMs(): number {
    return envInt('PANEL_REQUEST_TIMEOUT_MS', 120_000, { min: 1000 });
  },
  get panelVersion(): string {
    return envString('PANEL_VERSION', '1.0.0');
  },
};
