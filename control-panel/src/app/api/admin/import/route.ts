import type { ConfigKey, ChatParams } from '@/lib/types';
import { guard } from '@/server/auth';
import { getConfigStore, MANAGED_KEYS } from '@/server/config-store';
import { ApiHttpError, ok, readJsonBody, route } from '@/server/http';
import { getPresetStore } from '@/server/preset-store';
import { getRelayManager } from '@/server/relay-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ImportBody {
  payload?: unknown;
  restart?: unknown;
}

const ALLOWED_RELAY_KEYS: ConfigKey[] = ['POL_RELAY_PORT', 'POL_UPSTREAM_BASE', 'POL_SKIP_AUTH'];

/**
 * Import a settings document produced by `GET /api/admin/export`.
 *
 * Only whitelisted keys are applied. The relay API key is imported only when it
 * is present in the document (i.e. the export was made with secrets), and
 * presets are merged by name so an import never deletes existing work.
 */
export const POST = route(async ({ request }) => {
  const context = await guard(request, { scope: 'admin', rateLimit: 'admin' });
  const body = await readJsonBody<ImportBody>(request, 4 * 1024 * 1024);
  const payload = body.payload;
  const restart = body.restart === true;

  if (!payload || typeof payload !== 'object') {
    throw new ApiHttpError('validation_failed', 'payload must be a JSON object.', 422);
  }
  const document = payload as {
    kind?: string;
    relay?: Record<string, unknown>;
    presets?: unknown[];
  };
  if (document.kind && document.kind !== 'zes-relay-panel-settings') {
    throw new ApiHttpError(
      'validation_failed',
      `Unsupported document kind "${document.kind}" — expected zes-relay-panel-settings.`,
      422,
    );
  }

  const imported: string[] = [];
  const skipped: string[] = [];

  // ── relay configuration ──────────────────────────────────────────────────
  const store = getConfigStore();
  const current = await store.readValues();
  const candidate: Partial<Record<ConfigKey, string>> = {};
  const relaySection = document.relay ?? {};
  for (const key of MANAGED_KEYS) {
    if (!(key in relaySection)) continue;
    if (!ALLOWED_RELAY_KEYS.includes(key) && key === 'POL_API_KEY') {
      // Only import the key when it actually carries a value.
      const value = String(relaySection[key] ?? '');
      if (value === '') {
        skipped.push(`${key} (empty)`);
        continue;
      }
      candidate[key] = value;
      continue;
    }
    const value = relaySection[key];
    if (value === undefined || value === null || value === '') {
      skipped.push(`${key} (missing)`);
      continue;
    }
    candidate[key] = String(value).trim();
  }

  if (Object.keys(candidate).length > 0) {
    const validation = store.validate(candidate, current);
    const errors = validation.issues.filter((issue) => issue.level === 'error');
    if (errors.length > 0) {
      throw new ApiHttpError('validation_failed', 'Imported configuration is invalid.', 422, {
        issues: validation.issues,
      });
    }
    await store.save({ ...candidate, ...validation.normalized }, {
      touchSecret: candidate.POL_API_KEY !== undefined,
    });
    imported.push(...Object.keys(candidate));
  }

  // ── presets (merge by name, never destructive) ───────────────────────────
  if (Array.isArray(document.presets)) {
    const presetStore = getPresetStore();
    const existing = new Set((await presetStore.list()).map((preset) => preset.name));
    for (const raw of document.presets) {
      if (!raw || typeof raw !== 'object') continue;
      const preset = raw as { name?: unknown; params?: unknown; messages?: unknown };
      const name = typeof preset.name === 'string' ? preset.name : '';
      if (!name) {
        skipped.push('preset without a name');
        continue;
      }
      if (existing.has(name)) {
        skipped.push(`preset "${name}" (already present)`);
        continue;
      }
      try {
        await presetStore.create({
          name,
          params: (preset.params ?? {}) as ChatParams,
          messages: (Array.isArray(preset.messages) ? preset.messages : []) as Array<{
            role: 'system' | 'user' | 'assistant';
            content: string;
          }>,
        });
        existing.add(name);
        imported.push(`preset:${name}`);
      } catch (error) {
        skipped.push(
          `preset "${name}" (${error instanceof Error ? error.message : 'invalid'})`,
        );
      }
    }
  }

  let restarted = false;
  if (restart && imported.some((item) => ALLOWED_RELAY_KEYS.includes(item as ConfigKey))) {
    await getRelayManager().restart();
    restarted = true;
  }

  return ok({
    imported,
    skipped,
    restarted,
    importedBy: context.user.username,
  });
});
