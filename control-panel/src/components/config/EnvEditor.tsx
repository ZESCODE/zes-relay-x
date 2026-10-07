'use client';

import { useCallback, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, SectionTitle } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Input, Select, Toggle } from '@/components/ui/Input';
import { useToast } from '@/lib/hooks/useToast';
import { fetchConfig, revealConfigKey, saveConfig, validateConfig } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import type {
  ConfigDocument,
  ConfigKey,
  ConfigValidationResult,
  RelayStatus,
} from '@/lib/types';

export interface EnvEditorProps {
  initialDocument: ConfigDocument;
  relayStatus: RelayStatus;
}

type Draft = Partial<Record<ConfigKey, string>>;

/**
 * Editor for `data/.env`.
 *
 * • POL_API_KEY is never sent to the browser unless the operator explicitly
 *   reveals it (the reveal call is audited in the panel log)
 * • validation runs server-side (port range, URL scheme, flag/key consistency)
 * • the running values are diffed against the saved ones
 * • "Save & restart" applies the change to the live relay
 */
export function EnvEditor({ initialDocument, relayStatus }: EnvEditorProps) {
  const toast = useToast();
  const [document, setDocument] = useState(initialDocument);
  const [draft, setDraft] = useState<Draft>({});
  const [validation, setValidation] = useState<ConfigValidationResult | null>(null);
  const [pending, setPending] = useState<null | 'save' | 'saveRestart' | 'validate' | 'reveal' | 'reload'>(
    null,
  );
  const [restartOpen, setRestartOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const fieldFor = useCallback(
    (key: ConfigKey) => document.fields.find((field) => field.key === key),
    [document],
  );

  const currentValue = useCallback(
    (key: ConfigKey): string => draft[key] ?? fieldFor(key)?.value ?? '',
    [draft, fieldFor],
  );

  const dirty = useMemo(() => {
    return (Object.keys(draft) as ConfigKey[]).some((key) => {
      const field = fieldFor(key);
      if (!field) return false;
      const next = draft[key] ?? field.value;
      return next !== field.value;
    });
  }, [draft, fieldFor]);

  const errors = useMemo(
    () => validation?.issues.filter((issue) => issue.level === 'error') ?? [],
    [validation],
  );

  const payloadFor = useCallback(
    (values: Draft): Draft => {
      const payload: Draft = { ...values };
      // Never send an unchanged (masked, empty) API key back to the server.
      if (payload.POL_API_KEY === '' && fieldFor('POL_API_KEY')?.masked) delete payload.POL_API_KEY;
      return payload;
    },
    [fieldFor],
  );

  const runValidation = useCallback(
    async (values: Draft): Promise<ConfigValidationResult | null> => {
      try {
        const result = await validateConfig(payloadFor(values), true);
        setValidation(result);
        return result;
      } catch (caught) {
        toast.error('Validation failed', caught instanceof Error ? caught.message : String(caught));
        return null;
      }
    },
    [payloadFor, toast],
  );

  const save = useCallback(
    async (restart: boolean) => {
      setPending(restart ? 'saveRestart' : 'save');
      try {
        const check = validation ?? (await runValidation(draft));
        if (check && !check.valid) {
          toast.error('Configuration invalid', 'Fix the highlighted fields before saving.');
          return;
        }
        const result = await saveConfig({ ...payloadFor(draft) } as Record<string, string>, restart);
        const refreshed = await fetchConfig();
        setDocument(refreshed);
        setDraft({});
        setRevealed(null);
        setValidation(null);
        toast.success(
          restart ? 'Saved and restarted' : 'Configuration saved',
          result.dirty.length > 0
            ? `Still differs from the running relay: ${result.dirty.join(', ')}`
            : 'The running relay matches the saved file.',
        );
      } catch (caught) {
        toast.error('Could not save', caught instanceof Error ? caught.message : String(caught));
      } finally {
        setPending(null);
        setRestartOpen(false);
      }
    },
    [draft, payloadFor, runValidation, toast, validation],
  );

  const reveal = useCallback(async () => {
    setPending('reveal');
    try {
      const result = await revealConfigKey('POL_API_KEY');
      setRevealed(result.value);
      toast.warning('Secret revealed', 'This access was written to the panel log.');
    } catch (caught) {
      toast.error('Could not reveal the key', caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }, [toast]);

  const reload = useCallback(async () => {
    setPending('reload');
    try {
      const refreshed = await fetchConfig();
      setDocument(refreshed);
      setDraft({});
      setValidation(null);
      setRevealed(null);
      toast.info('Reloaded from disk');
    } finally {
      setPending(null);
    }
  }, [toast]);

  const apiKeyField = fieldFor('POL_API_KEY');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle hint={document.path} className="mb-0">
          Relay configuration
        </SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={document.exists ? 'green' : 'orange'}>
            {document.exists ? 'data/.env present' : 'using defaults (no file yet)'}
          </Badge>
          {document.updatedAt ? (
            <span className="text-[11px] text-white/40">
              updated {formatRelative(document.updatedAt)} · {document.passthrough} passthrough line(s)
            </span>
          ) : null}
          {dirty ? <Badge tone="orange">unsaved changes</Badge> : <Badge tone="green">in sync</Badge>}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card tone="plain">
          <CardHeader
            title="Values"
            subtitle="Only these four keys are managed; comments and other keys are preserved verbatim."
          />

          <div className="space-y-4">
            <Input
              label="POL_RELAY_PORT"
              value={currentValue('POL_RELAY_PORT')}
              onChange={(event) => setDraft((current) => ({ ...current, POL_RELAY_PORT: event.target.value }))}
              inputMode="numeric"
              hint={`Running relay uses port ${relayStatus.port}. Loopback only.`}
            />

            <Input
              label="POL_UPSTREAM_BASE"
              value={currentValue('POL_UPSTREAM_BASE')}
              onChange={(event) =>
                setDraft((current) => ({ ...current, POL_UPSTREAM_BASE: event.target.value }))
              }
              hint="OpenAI-compatible base URL, e.g. https://gen.pollinations.ai/v1"
            />

            <div className="space-y-1.5">
              <label
                htmlFor="pol-api-key"
                className="block text-[11px] font-semibold uppercase tracking-widest text-white/55"
              >
                POL_API_KEY
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="pol-api-key"
                  type={revealed !== null ? 'text' : 'password'}
                  value={revealed ?? draft.POL_API_KEY ?? ''}
                  placeholder={apiKeyField?.masked ? '•••••••• (stored — type to replace)' : 'no key stored'}
                  onChange={(event) => {
                    setRevealed(null);
                    setDraft((current) => ({ ...current, POL_API_KEY: event.target.value }));
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-xl px-3 py-2 font-mono text-sm glass-input"
                />
                <Button
                  variant="ghost"
                  onClick={() => void reveal()}
                  loading={pending === 'reveal'}
                  disabled={!apiKeyField?.masked}
                  title="Reveal the stored key (audited)"
                >
                  {revealed !== null ? 'Shown' : 'Reveal'}
                </Button>
              </div>
              <p className="text-xs text-white/40">
                {apiKeyField?.masked
                  ? 'A key is stored. It is never sent to the browser unless you press Reveal.'
                  : 'No key stored. Required when POL_SKIP_AUTH=false.'}
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <Toggle
                label="POL_SKIP_AUTH"
                hint="true ⇒ forward the caller's Authorization header. false ⇒ inject POL_API_KEY."
                checked={currentValue('POL_SKIP_AUTH') === 'true'}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, POL_SKIP_AUTH: value ? 'true' : 'false' }))
                }
              />
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              onClick={() => void runValidation(draft)}
              loading={pending === 'validate'}
              disabled={!dirty && validation !== null}
            >
              Validate
            </Button>
            <Button
              variant="frost"
              onClick={() => void save(false)}
              loading={pending === 'save'}
              disabled={!dirty}
            >
              Save
            </Button>
            <Button
              variant="primary"
              onClick={() => setRestartOpen(true)}
              loading={pending === 'saveRestart'}
              disabled={!dirty && document.dirty.length === 0}
              title="Save, then restart the relay so the new values take effect"
            >
              Save &amp; restart
            </Button>
            <Button variant="ghost" onClick={() => void reload()} loading={pending === 'reload'}>
              Reload from disk
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => setDraft({})}>
                Discard changes
              </Button>
            ) : null}
          </div>
        </Card>

        <div className="space-y-4">
          <Card tone="plain">
            <CardHeader title="Diff vs. running relay" subtitle="Values the live process was started with" />
            <ul className="space-y-2 text-xs">
              {document.fields.map((field) => {
                const running = field.runningValue;
                const saved = field.masked ? '(stored)' : field.value;
                const changed = running !== '' && saved !== '' && running !== saved;
                return (
                  <li key={field.key} className="rounded-xl border border-white/10 bg-white/5 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-white/70">{field.key}</span>
                      <Badge tone={changed ? 'orange' : 'green'}>{changed ? 'differs' : 'match'}</Badge>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-2 font-mono text-[11px]">
                      <span className="text-white/45">
                        file: <span className="text-white/75">{field.masked ? field.value || '(hidden)' : field.value || '—'}</span>
                      </span>
                      <span className="text-white/45">
                        running: <span className="text-white/75">{running || 'unknown'}</span>
                      </span>
                    </div>
                  </li>
                );
              })}
              {document.dirty.length > 0 ? (
                <li className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-2.5 text-orange-100">
                  The running relay was started with different values ({document.dirty.join(', ')}). Use{' '}
                  <strong>Save &amp; restart</strong> to apply them.
                </li>
              ) : null}
            </ul>
          </Card>

          <Card tone="plain">
            <CardHeader
              title="Validation"
              subtitle={validation ? 'Server-side checks + live relay probe' : 'Not run yet'}
            />
            {validation === null ? (
              <p className="text-xs text-white/45">
                Press <strong>Validate</strong> to check the port range, URL scheme, flag/key consistency
                and whether the relay currently answers <span className="font-mono">GET /v1/models</span>.
              </p>
            ) : (
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge tone={validation.valid ? 'green' : 'red'}>
                    {validation.valid ? 'valid' : 'invalid'}
                  </Badge>
                  <Badge tone={validation.probe.ok ? 'green' : validation.probe.attempted ? 'orange' : 'neutral'}>
                    probe: {validation.probe.attempted ? (validation.probe.ok ? 'ok' : 'failed') : 'skipped'}
                  </Badge>
                </div>
                <p className="text-white/60">{validation.probe.message}</p>
                <ul className="space-y-1">
                  {validation.issues.length === 0 ? (
                    <li className="text-white/45">No issues found.</li>
                  ) : (
                    validation.issues.map((issue, index) => (
                      <li
                        key={`${issue.key}-${index}`}
                        className={
                          issue.level === 'error'
                            ? 'rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-red-100'
                            : 'rounded-lg border border-orange-500/30 bg-orange-500/10 p-2 text-orange-100'
                        }
                      >
                        <span className="font-mono text-[11px]">{issue.key}</span> · {issue.message}
                      </li>
                    ))
                  )}
                </ul>
                {Object.keys(validation.normalized).length > 0 ? (
                  <div>
                    <p className="mb-1 text-[11px] uppercase tracking-widest text-white/45">
                      Normalised values that will be written
                    </p>
                    <pre className="code-pane scroll-slim">
                      {JSON.stringify(validation.normalized, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            )}
          </Card>

          <Card tone="plain">
            <CardHeader title="Where these values go" />
            <ul className="space-y-1.5 text-xs text-white/60">
              <li>
                Written to <span className="font-mono text-white/80">{document.path}</span> with mode 0600.
              </li>
              <li>
                The relay is spawned with them as environment variables (
                <span className="font-mono">POL_RELAY_PORT</span>,{' '}
                <span className="font-mono">POL_UPSTREAM_BASE</span>,{' '}
                <span className="font-mono">POL_SKIP_AUTH</span>, <span className="font-mono">POL_API_KEY</span>
                ).
              </li>
              <li>
                Changing <span className="font-mono">POL_RELAY_PORT</span> requires a restart — the panel
                keeps probing the old port until then.
              </li>
              <li>Nothing here is exposed to the browser bundle.</li>
            </ul>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={restartOpen}
        title="Save and restart the relay?"
        message={
          <>
            The relay will receive SIGTERM (SIGKILL after 5 s) and be started again with the new
            configuration. In-flight requests are dropped
            {relayStatus.owned ? '.' : ' — note that this relay was not spawned by the panel, so restart may be refused.'}
          </>
        }
        confirmLabel="Save & restart"
        pending={pending === 'saveRestart'}
        onClose={() => setRestartOpen(false)}
        onConfirm={() => void save(true)}
      />
    </div>
  );
}

export default EnvEditor;
