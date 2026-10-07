'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { HealthBadge } from '@/components/dashboard/HealthBadge';
import { restartRelay, startRelay, stopRelay } from '@/lib/api';
import { useRelayStatus } from '@/lib/hooks/useLiveMetrics';
import { useKeyboardShortcuts } from '@/lib/hooks/useKeyboardShortcuts';
import { useToast } from '@/lib/hooks/useToast';
import { formatRelative } from '@/lib/format';
import type { RelayStatus, SessionUser } from '@/lib/types';
import { Sidebar } from './Sidebar';
import { ThemeToggle } from './ThemeToggle';
import { useTheme } from './ThemeProvider';
import { ShortcutsHelp } from './ShortcutsHelp';
import { logout } from '@/lib/api';

export interface PanelShellProps {
  user: SessionUser | null;
  panelVersion: string;
  initialStatus: RelayStatus | null;
  children: ReactNode;
}

/**
 * Client shell for every panel page: sidebar, topbar, live relay banner,
 * keyboard shortcuts and the toast-backed lifecycle actions.
 */
export function PanelShell({ user, panelVersion, initialStatus, children }: PanelShellProps) {
  const router = useRouter();
  const toast = useToast();
  const { toggle: toggleTheme } = useTheme();
  const { status, error: statusError, refresh } = useRelayStatus(initialStatus);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const relayDown = Boolean(status) && !status?.running && status?.state !== 'starting';

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await logout();
      router.replace('/login');
      router.refresh();
    } catch (error) {
      toast.error('Sign out failed', error instanceof Error ? error.message : String(error));
      setSigningOut(false);
    }
  }, [router, toast]);

  const startRelayFromShortcut = useCallback(async () => {
    setBusy(true);
    try {
      const next = await startRelay();
      refresh();
      toast.success('Relay start requested', next.alreadyRunning ? 'It was already running.' : `pid ${next.pid}`);
    } catch (error) {
      toast.error('Start failed', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

  const stopRelayFromShortcut = useCallback(async () => {
    setBusy(true);
    try {
      const next = await stopRelay();
      refresh();
      toast.warning('Relay stopped', `port ${next.port} is free`);
    } catch (error) {
      toast.error('Stop failed', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

  const restartRelayFromShortcut = useCallback(async () => {
    setBusy(true);
    try {
      await restartRelay();
      refresh();
      toast.success('Relay restarted');
    } catch (error) {
      toast.error('Restart failed', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

  const shortcuts = useMemo(
    () => ({
      onNavigate: (path: string) => router.push(path),
      onHelp: () => setHelpOpen(true),
      onToggleTheme: () => toggleTheme(),
      onStartRelay: () => void startRelayFromShortcut(),
      onStopRelay: () => void stopRelayFromShortcut(),
    }),
    [router, startRelayFromShortcut, stopRelayFromShortcut, toggleTheme],
  );

  useKeyboardShortcuts(shortcuts);

  return (
    <div className="frost-bg frost-grid min-h-screen">
      <a href="#panel-main" className="sr-only sr-only-focusable glass-strong">
        Skip to content
      </a>

      <div className="relative z-10 mx-auto flex max-w-[110rem] gap-4 p-3 sm:p-5">
        {/* desktop sidebar */}
        <div className="hidden lg:block">
          <div className="sticky top-5 h-[calc(100vh-2.5rem)]">
            <Sidebar
              user={user}
              panelVersion={panelVersion}
              status={status}
              onSignOut={() => void handleSignOut()}
              signingOut={signingOut}
            />
          </div>
        </div>

        {/* mobile drawer */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setMobileOpen(false)}
              aria-hidden="true"
            />
            <div className="absolute inset-y-0 left-0 w-64 p-3">
              <Sidebar
                user={user}
                panelVersion={panelVersion}
                status={status}
                onNavigate={() => setMobileOpen(false)}
                onSignOut={() => void handleSignOut()}
                signingOut={signingOut}
                className="h-full"
              />
            </div>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <header className="glass-card flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
            >
              ☰
            </Button>

            <div className="flex min-w-0 flex-1 items-center gap-3">
              <HealthBadge status={status} showUptime />
              {status?.restarts ? (
                <Badge tone="orange" title="Automatic restarts since the panel booted">
                  {status.restarts} restart{status.restarts === 1 ? '' : 's'}
                </Badge>
              ) : null}
              {status?.lastHealthAt ? (
                <span className="hidden text-[11px] text-white/40 sm:inline">
                  probed {formatRelative(status.lastHealthAt)}
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="frost"
                onClick={() => void restartRelayFromShortcut()}
                loading={busy}
                disabled={!status?.owned && !status?.running}
                title="Restart is available for relays spawned by the panel"
              >
                Restart
              </Button>
              <ThemeToggle />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts (?)"
                onClick={() => setHelpOpen(true)}
              >
                ?
              </Button>
            </div>
          </header>

          {/* fail loud: relay unreachable */}
          {relayDown || statusError ? (
            <div
              role="alert"
              className="glass-frost-red flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 text-sm text-white/85"
            >
              <span aria-hidden="true" className="text-base">
                ⚠
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {statusError ? 'Cannot reach the panel API' : 'Relay is not responding'}
                </p>
                <p className="text-xs text-white/65">
                  {statusError ??
                    status?.lastError?.message ??
                    `Nothing answered on ${status?.baseUrl ?? 'the relay port'}. Start it below or check Config → upstream.`}
                </p>
              </div>
              <Button
                size="sm"
                variant="success"
                onClick={() => void startRelayFromShortcut()}
                loading={busy}
              >
                Start relay
              </Button>
              <Button size="sm" variant="ghost" onClick={refresh}>
                Re-check
              </Button>
            </div>
          ) : null}

          {/* fail loud: last error while otherwise running */}
          {!relayDown && status?.lastError && !statusError ? (
            <div
              role="status"
              className="glass-frost-orange rounded-2xl px-4 py-2.5 text-xs text-white/80"
            >
              <span className="font-semibold">Last relay error · </span>
              {status.lastError.message}
              <span className="text-white/50"> ({formatRelative(status.lastError.at)})</span>
            </div>
          ) : null}

          <main id="panel-main" className="min-w-0 flex-1 pb-6">
            {children}
          </main>
        </div>
      </div>

      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

export default PanelShell;
