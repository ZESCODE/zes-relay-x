'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/lib/hooks/useToast';
import { probeRelayHealth, restartRelay, startRelay, stopRelay } from '@/lib/api';
import { formatMs } from '@/lib/format';
import type { RelayStatus } from '@/lib/types';

export interface RelayControlsProps {
  status: RelayStatus | null;
  onChanged: (status: RelayStatus) => void;
  layout?: 'inline' | 'stacked';
}

/**
 * Start / stop / restart plus the guarded "force kill external process" path.
 *
 * The panel never terminates a relay it did not spawn without two explicit
 * confirmations — the second one requires typing the word KILL.
 */
export function RelayControls({ status, onChanged, layout = 'inline' }: RelayControlsProps) {
  const toast = useToast();
  const [pending, setPending] = useState<null | 'start' | 'stop' | 'restart' | 'kill' | 'probe'>(
    null,
  );
  const [stopOpen, setStopOpen] = useState(false);
  const [killStep, setKillStep] = useState<0 | 1 | 2>(0);
  const [killText, setKillText] = useState('');
  const [probeResult, setProbeResult] = useState<{
    ok: boolean;
    latencyMs: number | null;
    error: string | null;
    models: number | null;
  } | null>(null);

  const running = status?.running ?? false;
  const owned = status?.owned ?? false;
  const external = Boolean(status?.externalProcess.detected) || (running && !owned);

  async function run(action: 'start' | 'stop' | 'restart', fn: () => Promise<RelayStatus>) {
    setPending(action);
    try {
      const next = await fn();
      onChanged(next);
      toast.success(
        action === 'start' ? 'Relay started' : action === 'stop' ? 'Relay stopped' : 'Relay restarted',
        next.pid ? `pid ${next.pid} · port ${next.port}` : `port ${next.port}`,
      );
    } catch (error) {
      toast.error(
        `${action === 'start' ? 'Start' : action === 'stop' ? 'Stop' : 'Restart'} failed`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setPending(null);
    }
  }

  async function forceKill() {
    setPending('kill');
    try {
      const next = await stopRelay(true, 'force-kill-external');
      onChanged(next);
      toast.warning('External relay terminated', 'The port should be free now.');
    } catch (error) {
      toast.error('Force kill failed', error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
      setKillStep(0);
      setKillText('');
    }
  }

  async function probe() {
    setPending('probe');
    try {
      const result = await probeRelayHealth();
      setProbeResult(result);
      if (result.ok) toast.success('Health probe OK', `Answered in ${formatMs(result.latencyMs)}`);
      else toast.error('Health probe failed', result.error ?? 'No response');
    } catch (error) {
      toast.error('Health probe failed', error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={layout === 'stacked' ? 'flex flex-col gap-2' : 'flex flex-wrap items-center gap-2'}>
      <Button
        variant="success"
        icon={<span aria-hidden="true">▶</span>}
        loading={pending === 'start'}
        disabled={pending !== null || running}
        onClick={() => void run('start', startRelay)}
      >
        Start
      </Button>

      <Button
        variant="destructive"
        icon={<span aria-hidden="true">■</span>}
        loading={pending === 'stop'}
        disabled={pending !== null || (!running && !external)}
        onClick={() => setStopOpen(true)}
      >
        Stop
      </Button>

      <Button
        variant="default"
        icon={<span aria-hidden="true">⟳</span>}
        loading={pending === 'restart'}
        disabled={pending !== null || (!running && !owned)}
        onClick={() => void run('restart', restartRelay)}
        title={
          running && !owned
            ? 'Restarts are only available for relays spawned by the panel'
            : 'Graceful restart (SIGTERM → 5s → SIGKILL)'
        }
      >
        Restart
      </Button>

      <Button variant="ghost" loading={pending === 'probe'} disabled={pending !== null} onClick={() => void probe()}>
        Probe health
      </Button>

      {external && status?.externalProcess.detected ? (
        <Button variant="destructive" onClick={() => setKillStep(1)} disabled={pending !== null}>
          Force kill external process
        </Button>
      ) : null}

      {probeResult ? (
        <Badge tone={probeResult.ok ? 'green' : 'red'} size="md">
          {probeResult.ok
            ? `${formatMs(probeResult.latencyMs)} · ${probeResult.models ?? 0} models`
            : (probeResult.error ?? 'failed')}
        </Badge>
      ) : null}

      {/* ── stop confirmation ─────────────────────────────────────────── */}
      <ConfirmDialog
        open={stopOpen}
        title="Stop the relay?"
        message={
          owned ? (
            <>
              The relay process (pid <span className="font-mono">{status?.pid ?? '—'}</span>) will receive
              SIGTERM, then SIGKILL after 5 seconds if it does not exit. In-flight requests are dropped.
            </>
          ) : (
            <>
              This relay was <strong>not</strong> started by the panel. Stopping it requires the force-kill
              confirmation below.
            </>
          )
        }
        confirmLabel="Stop relay"
        destructive
        pending={pending === 'stop'}
        onClose={() => setStopOpen(false)}
        onConfirm={() => {
          setStopOpen(false);
          if (owned) void run('stop', () => stopRelay());
          else setKillStep(1);
        }}
      />

      {/* ── force kill, step 1 ────────────────────────────────────────── */}
      <ConfirmDialog
        open={killStep === 1}
        title="Force kill an external process"
        message={
          <>
            <p>
              Port <span className="font-mono">{status?.port}</span> is held by a process the panel does not
              own{status?.externalProcess.pid ? ` (pid ${status.externalProcess.pid})` : ''}.
            </p>
            <p className="mt-2 text-white/60">
              Terminating it may interrupt other services. The panel will send SIGTERM to that pid. This action
              is logged.
            </p>
          </>
        }
        confirmLabel="Continue"
        destructive
        onClose={() => setKillStep(0)}
        onConfirm={() => setKillStep(2)}
      />

      {/* ── force kill, step 2 ────────────────────────────────────────── */}
      <Modal
        open={killStep === 2}
        onClose={() => setKillStep(0)}
        title="Final confirmation"
        description="Type KILL to terminate the external process."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setKillStep(0)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={pending === 'kill'}
              disabled={killText !== 'KILL'}
              onClick={() => void forceKill()}
            >
              Send SIGTERM to pid {status?.externalProcess.pid ?? '?'}
            </Button>
          </>
        }
      >
        <input
          value={killText}
          onChange={(event) => setKillText(event.target.value)}
          className="w-full rounded-xl px-3 py-2 font-mono text-sm glass-input"
          placeholder="KILL"
          aria-label="Type KILL to confirm"
          autoComplete="off"
          spellCheck={false}
        />
      </Modal>
    </div>
  );
}

export default RelayControls;
