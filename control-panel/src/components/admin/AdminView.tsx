'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, SectionTitle } from '@/components/ui/Card';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Input, Select, Toggle } from '@/components/ui/Input';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { RelayControls } from '@/components/dashboard/RelayControls';
import { useToast } from '@/lib/hooks/useToast';
import {
  backupDownloadUrl,
  changePassword,
  createBackup,
  createToken,
  exportSettings,
  fetchSystemInfo,
  importSettings,
  listBackups,
  listTokens,
  resetData,
  revokeToken,
} from '@/lib/api';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatRelative,
  formatUptime,
  shortId,
} from '@/lib/format';
import type { ApiToken, BackupEntry, RelayStatus, SystemInfo, TokenScope } from '@/lib/types';

export interface AdminViewProps {
  initialSystem: SystemInfo;
  initialTokens: ApiToken[];
  initialBackups: BackupEntry[];
  initialBackupBytes: number;
  relayStatus: RelayStatus;
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tokens', label: 'API tokens' },
  { id: 'backups', label: 'Backups' },
  { id: 'data', label: 'Data' },
  { id: 'account', label: 'Account' },
];

export function AdminView({
  initialSystem,
  initialTokens,
  initialBackups,
  initialBackupBytes,
  relayStatus,
}: AdminViewProps) {
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [system, setSystem] = useState(initialSystem);
  const [tokens, setTokens] = useState(initialTokens);
  const [backups, setBackups] = useState(initialBackups);
  const [backupBytes, setBackupBytes] = useState(initialBackupBytes);
  const [status, setStatus] = useState(relayStatus);

  /* ── token creation ─────────────────────────────────────────────────── */
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [tokenScopes, setTokenScopes] = useState<TokenScope[]>(['read']);
  const [tokenDays, setTokenDays] = useState('');
  const [mintedSecret, setMintedSecret] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null);

  /* ── backups ────────────────────────────────────────────────────────── */
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);

  /* ── data actions ───────────────────────────────────────────────────── */
  const [resetTargets, setResetTargets] = useState({
    metrics: true,
    logs: true,
    events: false,
    errors: true,
  });
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  /* ── account ────────────────────────────────────────────────────────── */
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordPending, setPasswordPending] = useState(false);

  const refreshSystem = useCallback(async () => {
    try {
      setSystem(await fetchSystemInfo());
    } catch (error) {
      toast.error('Could not refresh system info', error instanceof Error ? error.message : String(error));
    }
  }, [toast]);

  const mkToken = useCallback(async () => {
    try {
      const created = await createToken({
        name: tokenName.trim(),
        scopes: tokenScopes,
        expiresInDays: tokenDays.trim() === '' ? null : Number.parseInt(tokenDays, 10),
      });
      setTokens((current) => [created.token, ...current]);
      setMintedSecret(created.secret);
      setTokenName('');
      setTokenDays('');
      toast.success('Token created', 'Copy it now — it is shown once.');
    } catch (error) {
      toast.error('Could not create the token', error instanceof Error ? error.message : String(error));
    }
  }, [tokenDays, tokenName, tokenScopes, toast]);

  const doRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    try {
      const { token } = await revokeToken(revokeTarget.id);
      setTokens((current) => current.map((item) => (item.id === token.id ? token : item)));
      toast.warning('Token revoked', token.name);
    } catch (error) {
      toast.error('Could not revoke the token', error instanceof Error ? error.message : String(error));
    } finally {
      setRevokeTarget(null);
    }
  }, [revokeTarget, toast]);

  const doBackup = useCallback(async () => {
    try {
      const { backup } = await createBackup(includeSecrets);
      const listing = await listBackups();
      setBackups(listing.backups);
      setBackupBytes(listing.totalBytes);
      setBackupOpen(false);
      toast.success('Backup created', `${backup.name} · ${formatBytes(backup.bytes)}`);
    } catch (error) {
      toast.error('Backup failed', error instanceof Error ? error.message : String(error));
    }
  }, [includeSecrets, toast]);

  const doReset = useCallback(async () => {
    try {
      const result = await resetData(resetTargets);
      setResetOpen(false);
      toast.success('Buffers cleared', result.cleared.join(', '));
    } catch (error) {
      toast.error('Reset failed', error instanceof Error ? error.message : String(error));
    }
  }, [resetTargets, toast]);

  const doExport = useCallback(async () => {
    try {
      const payload = await exportSettings(false);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `zes-panel-settings-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('Settings exported', 'Secrets are excluded.');
    } catch (error) {
      toast.error('Export failed', error instanceof Error ? error.message : String(error));
    }
  }, [toast]);

  const doImport = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const payload = JSON.parse(text) as Record<string, unknown>;
        const result = await importSettings(payload, { restart: false });
        toast.success(
          'Settings imported',
          `${result.imported.length} applied${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}`,
        );
      } catch (error) {
        toast.error('Import failed', error instanceof Error ? error.message : String(error));
      }
    },
    [toast],
  );

  const changeAccountPassword = useCallback(async () => {
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    setPasswordPending(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await refreshSystem();
      toast.success('Password changed');
    } catch (error) {
      toast.error('Could not change the password', error instanceof Error ? error.message : String(error));
    } finally {
      setPasswordPending(false);
    }
  }, [confirmPassword, currentPassword, newPassword, refreshSystem, toast]);

  const scopeOptions = useMemo(
    () => [
      { value: 'read', label: 'read — GET endpoints' },
      { value: 'write', label: 'write — lifecycle & chat' },
      { value: 'admin', label: 'admin — config, tokens, backups' },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Tabs
        tabs={TABS}
        active={tab}
        onChange={setTab}
        actions={
          <>
            <Badge tone="blue">panel v{system.panelVersion}</Badge>
            <Badge tone="neutral">node {system.nodeVersion}</Badge>
          </>
        }
      />

      {/* ── overview ───────────────────────────────────────────────────── */}
      <TabPanel id="overview" active={tab}>
        <div className="grid gap-4 xl:grid-cols-2">
          <Card tone="plain">
            <CardHeader
              title="Lifecycle"
              subtitle="Same controls as the dashboard, plus the pid inventory"
              actions={<Button size="sm" variant="ghost" onClick={refreshSystem}>Refresh</Button>}
            />
            <RelayControls status={status} onChanged={setStatus} layout="inline" />
            <dl className="mt-4 space-y-1.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">State</dt>
                <dd className="font-mono text-white/80">
                  {status.state} {status.owned ? '(managed)' : '(external)'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">PID</dt>
                <dd className="font-mono text-white/80">{status.pid ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Restarts since boot</dt>
                <dd className="font-mono text-white/80">{status.restarts}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Panel uptime</dt>
                <dd className="font-mono text-white/80">{formatUptime(system.uptimeMs)}</dd>
              </div>
            </dl>
          </Card>

          <Card tone="plain">
            <CardHeader title="Runtime" subtitle="Versions and hashes" />
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Panel version</dt>
                <dd className="font-mono text-white/80">{system.panelVersion}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Node</dt>
                <dd className="font-mono text-white/80">{system.nodeVersion}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Python ({system.pythonBin})</dt>
                <dd className="font-mono text-white/80">{system.pythonVersion ?? 'not found'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Platform</dt>
                <dd className="font-mono text-white/80">{system.platform}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Process</dt>
                <dd className="font-mono text-white/80">
                  pid {system.pid} · rss {formatBytes(system.memory.rss)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Data directory</dt>
                <dd className="max-w-[14rem] truncate font-mono text-white/80" title={system.dataDir}>
                  {system.dataDir} ({formatBytes(system.dataDirSizeBytes)})
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Relay script</dt>
                <dd className="max-w-[14rem] truncate font-mono text-white/80" title={system.relayScript ?? ''}>
                  {system.relayScript ?? 'not found'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">SHA-256(pol_relay.py)</dt>
                <dd className="font-mono text-white/80" title={system.relayScriptSha256 ?? ''}>
                  {system.relayScriptSha256 ? shortId(system.relayScriptSha256, 16) : '—'}
                </dd>
              </div>
            </dl>
          </Card>

          <Card tone="plain" className="xl:col-span-2">
            <CardHeader
              title="Environment"
              subtitle="Only the variables the panel reads; secrets are masked"
            />
            <div className="grid gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
              {system.env.map((item) => (
                <div
                  key={item.key}
                  className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1"
                >
                  <span className="font-mono text-[11px] text-white/55">{item.key}</span>
                  <span className="truncate font-mono text-[11px] text-white/85">{item.value}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </TabPanel>

      {/* ── tokens ─────────────────────────────────────────────────────── */}
      <TabPanel id="tokens" active={tab}>
        <Card tone="plain">
          <CardHeader
            title="API tokens"
            subtitle="Bearer credentials for scripts and CI — read/write/admin scopes"
            actions={<Button size="sm" variant="frost" onClick={() => setTokenOpen(true)}>New token</Button>}
          />
          {tokens.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-white/40">
              No tokens yet. Create one to drive the panel from a script.
            </p>
          ) : (
            <div className="scroll-slim overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-xs">
                <caption className="sr-only">API token inventory</caption>
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-white/45">
                    <th scope="col" className="px-2 py-1">Name</th>
                    <th scope="col" className="px-2 py-1">Prefix</th>
                    <th scope="col" className="px-2 py-1">Scopes</th>
                    <th scope="col" className="px-2 py-1">Created</th>
                    <th scope="col" className="px-2 py-1">Last used</th>
                    <th scope="col" className="px-2 py-1">Expires</th>
                    <th scope="col" className="px-2 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((token) => (
                    <tr key={token.id} className="border-t border-white/5">
                      <td className="px-2 py-2 text-white/85">{token.name}</td>
                      <td className="px-2 py-2 font-mono text-white/60">{token.prefix}…</td>
                      <td className="px-2 py-2">
                        <span className="flex gap-1">
                          {token.scopes.map((scope) => (
                            <Badge key={scope} tone={scope === 'admin' ? 'red' : scope === 'write' ? 'orange' : 'blue'}>
                              {scope}
                            </Badge>
                          ))}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-white/55">{formatDateTime(token.createdAt)}</td>
                      <td className="px-2 py-2 text-white/55">
                        {token.lastUsedAt ? formatRelative(token.lastUsedAt) : 'never'}
                      </td>
                      <td className="px-2 py-2 text-white/55">
                        {token.expiresAt ? formatDateTime(token.expiresAt) : 'no expiry'}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {token.revokedAt ? (
                          <Badge tone="neutral">revoked {formatRelative(token.revokedAt)}</Badge>
                        ) : (
                          <Button size="sm" variant="destructive" onClick={() => setRevokeTarget(token)}>
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-[11px] text-white/40">
            Usage: <span className="font-mono">curl -H &quot;Authorization: Bearer zes_…&quot; http://127.0.0.1:3000/api/metrics/summary</span>
          </p>
        </Card>
      </TabPanel>

      {/* ── backups ────────────────────────────────────────────────────── */}
      <TabPanel id="backups" active={tab}>
        <Card tone="plain">
          <CardHeader
            title="Backups"
            subtitle={`${backups.length} archive(s) · ${formatBytes(backupBytes)} on disk`}
            actions={
              <Button size="sm" variant="frost" onClick={() => setBackupOpen(true)}>
                Create backup
              </Button>
            }
          />
          {backups.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-white/40">
              No backups yet. Archives are written to <span className="font-mono">data/backups/</span>.
            </p>
          ) : (
            <ul className="space-y-2">
              {backups.map((backup) => (
                <li
                  key={backup.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-2.5 text-xs"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-white/85">{backup.name}</span>
                    <span className="block text-white/45">
                      {formatDateTime(backup.createdAt)} · {formatBytes(backup.bytes)} · {backup.files} files
                    </span>
                  </span>
                  <Badge tone={backup.containsSecrets ? 'red' : 'green'}>
                    {backup.containsSecrets ? 'contains secrets' : 'secrets excluded'}
                  </Badge>
                  <a
                    href={backupDownloadUrl(backup.id)}
                    className="glass-btn inline-flex h-8 items-center rounded-xl px-3 text-xs text-white/85"
                    download
                  >
                    Download
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </TabPanel>

      {/* ── data ───────────────────────────────────────────────────────── */}
      <TabPanel id="data" active={tab}>
        <div className="grid gap-4 xl:grid-cols-2">
          <Card tone="plain">
            <CardHeader title="Clear buffers" subtitle="Metrics, logs, errors and lifecycle history" />
            <div className="space-y-3">
              {(
                [
                  ['metrics', 'Metrics counters & time series'],
                  ['logs', 'Log ring buffer'],
                  ['errors', 'Recent error feed'],
                  ['events', 'Lifecycle event history'],
                ] as const
              ).map(([key, label]) => (
                <Toggle
                  key={key}
                  label={label}
                  checked={resetTargets[key]}
                  onChange={(value) => setResetTargets((current) => ({ ...current, [key]: value }))}
                />
              ))}
            </div>
            <div className="mt-4">
              <Button variant="destructive" onClick={() => setResetOpen(true)}>
                Clear selected buffers
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-white/40">
              On-disk JSONL files are preserved — only the in-memory buffers are dropped.
            </p>
          </Card>

          <Card tone="plain">
            <CardHeader title="Settings export / import" subtitle="Secrets excluded by default" />
            <div className="space-y-3">
              <Button variant="default" onClick={() => void doExport()}>
                Export settings JSON
              </Button>
              <div>
                <input
                  ref={importRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void doImport(file);
                    event.target.value = '';
                  }}
                />
                <Button variant="ghost" onClick={() => importRef.current?.click()}>
                  Import settings JSON…
                </Button>
              </div>
              <ul className="space-y-1 text-[11px] text-white/45">
                <li>Export contains relay configuration, panel knobs, token metadata and presets.</li>
                <li>Import only applies whitelisted relay keys and merges presets by name.</li>
                <li>Token secrets and password hashes are never exported.</li>
              </ul>
            </div>
          </Card>
        </div>
      </TabPanel>

      {/* ── account ────────────────────────────────────────────────────── */}
      <TabPanel id="account" active={tab}>
        <Card tone="plain" className="max-w-xl">
          <CardHeader
            title="Account"
            subtitle="Password hashing uses scrypt (N=16384, r=8, p=1) with a per-user salt"
          />
          <div className="space-y-3">
            <Input
              label="Current password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
            <Input
              label="New password"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              hint="Minimum 10 characters."
            />
            <Input
              label="Confirm new password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              error={confirmPassword !== '' && confirmPassword !== newPassword ? 'Passwords differ' : undefined}
            />
            <Button
              variant="frost"
              onClick={() => void changeAccountPassword()}
              loading={passwordPending}
              disabled={!currentPassword || newPassword.length < 10}
            >
              Change password
            </Button>
          </div>
        </Card>
      </TabPanel>

      {/* ── modals ─────────────────────────────────────────────────────── */}
      <Modal
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
        title="Create API token"
        description="The secret is displayed once and stored only as a SHA-256 hash."
        footer={
          <>
            <Button variant="ghost" onClick={() => setTokenOpen(false)}>
              Close
            </Button>
            <Button variant="frost" onClick={() => void mkToken()} disabled={tokenName.trim().length < 2}>
              Create
            </Button>
          </>
        }
      >
        <Input
          label="Name"
          value={tokenName}
          onChange={(event) => setTokenName(event.target.value)}
          placeholder="ci-deploy"
          maxLength={64}
        />
        <Select
          label="Scope"
          value={tokenScopes[0] ?? 'read'}
          onChange={(event) => setTokenScopes([event.target.value as TokenScope])}
          options={scopeOptions}
          hint="read = GET only · write = lifecycle + chat · admin = everything"
        />
        <Input
          label="Expires in days"
          value={tokenDays}
          onChange={(event) => setTokenDays(event.target.value)}
          placeholder="blank = no expiry"
          inputMode="numeric"
        />
        {mintedSecret ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
            <p className="mb-1 text-[11px] uppercase tracking-widest text-emerald-200">
              Copy this secret now
            </p>
            <code className="block break-all font-mono text-[11px] text-emerald-100">{mintedSecret}</code>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={backupOpen}
        title="Create a backup?"
        message={
          <div className="space-y-3">
            <p>Every file under the data directory is archived into a timestamped zip.</p>
            <Toggle
              label="Include secrets"
              hint="Adds POL_API_KEY to the archive (the session secret is never included)."
              checked={includeSecrets}
              onChange={setIncludeSecrets}
            />
          </div>
        }
        confirmLabel="Create backup"
        onClose={() => setBackupOpen(false)}
        onConfirm={() => void doBackup()}
      />

      <ConfirmDialog
        open={resetOpen}
        title="Clear buffers?"
        message="Clears the in-memory metrics, logs and error feed. Files on disk are kept."
        confirmLabel="Clear buffers"
        destructive
        requireText="RESET"
        confirmText={resetConfirmText}
        onConfirmTextChange={setResetConfirmText}
        onClose={() => {
          setResetOpen(false);
          setResetConfirmText('');
        }}
        onConfirm={() => {
          void doReset().finally(() => setResetConfirmText(''));
        }}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke token?"
        message={`"${revokeTarget?.name}" will stop working immediately. This cannot be undone.`}
        confirmLabel="Revoke"
        destructive
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => void doRevoke()}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle className="mb-0" hint="every action on this page is written to the panel log">
          Administration
        </SectionTitle>
        <span className="text-[11px] text-white/35">
          {formatNumber(system.env.length)} environment variables · uptime {formatUptime(system.uptimeMs)}
        </span>
      </div>
    </div>
  );
}

export default AdminView;
