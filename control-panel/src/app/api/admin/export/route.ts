import { guard } from '@/server/auth';
import { getConfigStore } from '@/server/config-store';
import { env } from '@/server/env';
import { paths } from '@/server/fs-paths';
import { ok, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { getPresetStore } from '@/server/preset-store';
import { getTokenStore } from '@/server/token-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Settings export as a portable JSON document.
 *
 * Secrets (POL_API_KEY, admin password hash, session secret, token hashes) are
 * excluded unless `?secrets=true`, and even then only the relay API key is
 * included — password material never leaves the panel.
 */
export const GET = route(
  async ({ request }) => {
    const context = await guard(request, { scope: 'admin' });
    const url = new URL(request.url);
    const includeSecrets = url.searchParams.get('secrets') === 'true';

    const store = getConfigStore();
    const relayValues = await store.readValues();
    const presets = await getPresetStore().list();
    const tokens = await getTokenStore().list();

    getLogBus().push({
      source: 'system',
      level: 'warn',
      message: `Settings exported by ${context.user.username} (${
        includeSecrets ? 'with' : 'without'
      } secrets).`,
    });

    return ok({
      kind: 'zes-relay-panel-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      panel: {
        version: env.panelVersion,
        node: process.version,
        dataDir: paths().dataDir,
        theme: null,
      },
      relay: {
        POL_RELAY_PORT: relayValues.POL_RELAY_PORT,
        POL_UPSTREAM_BASE: relayValues.POL_UPSTREAM_BASE,
        POL_SKIP_AUTH: relayValues.POL_SKIP_AUTH,
        ...(includeSecrets ? { POL_API_KEY: relayValues.POL_API_KEY } : {}),
      },
      env: {
        PANEL_HOST: env.host,
        PANEL_PORT: env.port,
        PANEL_SESSION_TTL_HOURS: env.sessionTtlHours,
        PANEL_HEALTH_INTERVAL_MS: env.healthIntervalMs,
        PANEL_AUTORESTART: env.autoRestart,
        PANEL_CHAT_RATE_LIMIT: env.chatRateLimit,
        PANEL_LOGIN_RATE_LIMIT: env.loginRateLimit,
        PANEL_MAX_LOG_ENTRIES: env.maxLogEntries,
        PANEL_METRICS_SAMPLES: env.metricsSamples,
      },
      tokens: tokens.map((token) => ({
        name: token.name,
        scopes: token.scopes,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        expiresAt: token.expiresAt,
        revokedAt: token.revokedAt,
        note: 'secrets are never exported — create a new token after importing',
      })),
      presets,
    });
  },
  { logAccess: false },
);
