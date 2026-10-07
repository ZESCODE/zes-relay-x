import type { ConfigKey } from '@/lib/types';
import { guard } from '@/server/auth';
import { getConfigStore, MANAGED_KEYS, SECRET_KEYS } from '@/server/config-store';
import { ApiHttpError, ok, readJsonBody, route } from '@/server/http';
import { getLogBus } from '@/server/log-bus';
import { getRelayManager } from '@/server/relay-manager';
import { redactText } from '@/server/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PutBody {
  values?: Record<string, unknown>;
  restart?: unknown;
}

/** GET /api/config — masked view of data/.env plus the running values. */
export const GET = route(
  async ({ request }) => {
    await guard(request, { scope: 'read' });
    return ok(await getConfigStore().load());
  },
  { logAccess: false },
);

/**
 * PUT /api/config — validate then persist.
 *
 * Secret values that arrive empty are left untouched, so the UI can save the
 * other fields without ever re-sending the API key.
 */
export const PUT = route(async ({ request }) => {
  const context = await guard(request, { scope: 'write', rateLimit: 'admin' });
  const body = await readJsonBody<PutBody>(request, 64 * 1024);
  const rawValues = body.values ?? {};
  const restart = body.restart === true;

  if (!rawValues || typeof rawValues !== 'object') {
    throw new ApiHttpError('validation_failed', 'values must be an object.', 422);
  }

  const store = getConfigStore();
  const current = await store.readValues();
  const candidate: Partial<Record<ConfigKey, string>> = {};

  for (const key of MANAGED_KEYS) {
    const value = (rawValues as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if ((SECRET_KEYS as string[]).includes(key) && value === '') continue; // keep existing
    candidate[key] = String(value).trim();
  }

  if (Object.keys(candidate).length === 0) {
    throw new ApiHttpError('validation_failed', 'No configuration values were provided.', 422);
  }

  const validation = store.validate(candidate, current);
  const errors = validation.issues.filter((issue) => issue.level === 'error');
  if (errors.length > 0) {
    throw new ApiHttpError('validation_failed', 'Configuration is invalid.', 422, {
      issues: validation.issues,
    });
  }

  // Apply normalisation (trimmed URLs, canonical booleans, numeric port).
  const toSave: Partial<Record<ConfigKey, string>> = { ...candidate, ...validation.normalized };
  await store.save(toSave, { touchSecret: candidate.POL_API_KEY !== undefined });

  const maskedKeys = Object.keys(toSave).map((key) =>
    (SECRET_KEYS as string[]).includes(key) ? `${key}=***` : `${key}=${toSave[key as ConfigKey]}`,
  );
  getLogBus().push({
    source: 'system',
    level: 'info',
    message: `Config updated by ${context.user.username}: ${redactText(maskedKeys.join(' '))}`,
  });

  let relayStatus = null;
  let restarted = false;
  if (restart) {
    const manager = getRelayManager();
    relayStatus = await manager.restart();
    restarted = true;
  }

  const document = await store.load();
  return ok({
    saved: true,
    dirty: document.dirty,
    restarted,
    relay: relayStatus,
  });
});
