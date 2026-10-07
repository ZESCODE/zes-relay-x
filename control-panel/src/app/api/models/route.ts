import type { ModelsResponse } from '@/lib/types';
import { guard } from '@/server/auth';
import { getConfigStore } from '@/server/config-store';
import { ApiHttpError, ok, route } from '@/server/http';
import { getMetrics } from '@/server/metrics';
import { extractModels, fetchRelayModels } from '@/server/upstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CacheEntry {
  at: number;
  models: ModelsResponse;
}

const CACHE_TTL_MS = 60_000;
const FALLBACK_TTL_MS = 5_000;
const CACHE_KEY = Symbol.for('zes.panel.models-cache');

type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: CacheEntry };

/** Always-known fallback so the playground dropdown is never empty. */
const FALLBACK_MODELS: ModelsResponse['models'] = [
  { id: 'openai', object: 'model', owned_by: 'pollinations' },
  { id: 'openai-fast', object: 'model', owned_by: 'pollinations' },
  { id: 'mistral', object: 'model', owned_by: 'pollinations' },
];

/**
 * Proxies the relay's `GET /v1/models`.
 *
 * The relay itself proxies the upstream, so this route caches for 60s and falls
 * back to a short-lived cache (or a static list) when the relay is down — the
 * playground keeps working and the dashboard keeps showing the last known set.
 */
export const GET = route(async ({ request }) => {
  await guard(request, { scope: 'read' });
  const url = new URL(request.url);
  const refresh = url.searchParams.get('refresh') === 'true';
  const scope = globalThis as GlobalWithCache;
  const now = Date.now();
  const cached = scope[CACHE_KEY];

  if (!refresh && cached && now - cached.at < CACHE_TTL_MS) {
    return ok({ ...cached.models, source: 'cache' as const });
  }

  const values = await getConfigStore().readValues();
  const port = Number.parseInt(values.POL_RELAY_PORT, 10) || 7179;
  const startedAt = Date.now();
  const result = await fetchRelayModels(port, 4000);

  if (result.ok) {
    const models = result.models.length > 0 ? result.models : extractModels(result.raw);
    const payload: ModelsResponse = {
      models,
      fetchedAt: new Date().toISOString(),
      latencyMs: result.latencyMs,
      source: 'relay',
      error: null,
    };
    scope[CACHE_KEY] = { at: now, models: payload };
    return ok(payload);
  }

  // Relay unreachable: record the failure and degrade gracefully.
  getMetrics().record({
    source: 'panel',
    endpoint: '/v1/models',
    model: null,
    status: 503,
    streamed: false,
    durationMs: Date.now() - startedAt,
    error: { code: 'relay_unavailable', message: result.error ?? 'Relay unreachable' },
  });

  if (cached && now - cached.at < 10 * 60_000) {
    const payload: ModelsResponse = {
      ...cached.models,
      fetchedAt: new Date().toISOString(),
      latencyMs: result.latencyMs,
      source: 'cache',
      error: result.error,
    };
    scope[CACHE_KEY] = { at: now - CACHE_TTL_MS + FALLBACK_TTL_MS, models: payload };
    return ok(payload);
  }

  if (refresh) {
    throw new ApiHttpError(
      'relay_unavailable',
      `Relay unreachable while refreshing models: ${result.error ?? 'unknown error'}`,
      503,
    );
  }

  const payload: ModelsResponse = {
    models: FALLBACK_MODELS,
    fetchedAt: new Date().toISOString(),
    latencyMs: result.latencyMs,
    source: 'fallback',
    error: result.error,
  };
  scope[CACHE_KEY] = { at: now - CACHE_TTL_MS + FALLBACK_TTL_MS, models: payload };
  return ok(payload);
});
