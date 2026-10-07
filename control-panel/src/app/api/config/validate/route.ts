import type { ConfigKey, ConfigValidationResult } from '@/lib/types';
import { guard } from '@/server/auth';
import { getConfigStore, MANAGED_KEYS } from '@/server/config-store';
import { ApiHttpError, ok, readJsonBody, route } from '@/server/http';
import { getRelayManager } from '@/server/relay-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ValidateBody {
  values?: Record<string, unknown>;
  probe?: unknown;
}

/**
 * Dry-run validation (port range, URL scheme, boolean syntax, key/flag
 * consistency) plus an optional live probe of the running relay so the operator
 * knows whether the *current* configuration is actually serving traffic.
 */
export const POST = route(async ({ request }) => {
  await guard(request, { scope: 'read' });

  const body = await readJsonBody<ValidateBody>(request, 64 * 1024).catch(
    () => ({}) as ValidateBody,
  );
  const rawValues = body.values ?? {};
  if (rawValues && typeof rawValues !== 'object') {
    throw new ApiHttpError('validation_failed', 'values must be an object.', 422);
  }

  const store = getConfigStore();
  const current = await store.readValues();
  const candidate: Partial<Record<ConfigKey, string>> = {};
  for (const key of MANAGED_KEYS) {
    const value = (rawValues as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'POL_API_KEY') {
      // Only validate a *new* key if one was typed; the masked placeholder is
      // never sent back from the browser.
      candidate[key] = String(value);
      continue;
    }
    candidate[key] = String(value).trim();
  }

  const { issues, normalized } = store.validate(candidate, current);

  let probeResult: ConfigValidationResult['probe'] = {
    attempted: false,
    ok: null,
    status: null,
    latencyMs: null,
    message: 'Probe skipped.',
  };

  if (body.probe === true) {
    const manager = getRelayManager();
    const probe = await manager.health();
    probeResult = {
      attempted: true,
      ok: probe.ok,
      status: probe.status,
      latencyMs: probe.latencyMs,
      message: probe.ok
        ? `Relay answered GET /v1/models in ${probe.latencyMs ?? '?'} ms with ${
            probe.modelCount ?? 0
          } model(s).`
        : `Relay did not answer: ${probe.error ?? 'unknown error'}`,
    };
  }

  const result: ConfigValidationResult = {
    valid: issues.every((issue) => issue.level !== 'error'),
    issues,
    normalized,
    probe: probeResult,
  };
  return ok(result);
});
