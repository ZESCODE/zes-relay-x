import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { HealthProbe, LifecycleEvent, LifecycleEventKind, RelayState, RelayStatus } from '@/lib/types';
import { env, envOptional } from './env';
import { getConfigStore, type RelayConfigValues } from './config-store';
import { appendJsonl, ensureDataLayout, paths, resolveFromPanel, sha256File } from './fs-paths';
import { getLogBus } from './log-bus';
import { getMetrics } from './metrics';
import { signalName } from './signals';
import { parseListenLine } from './relay-log-parser';
import { RingBuffer } from './ring-buffer';
import { findProcessOnPort, isPortListening, probeRelayHealth } from './upstream';

/**
 * Relay lifecycle manager.
 *
 * Owns the `python3 pol_relay.py` child process:
 *   • start / stop / restart with a graceful SIGTERM → SIGKILL escalation
 *   • adoption of an already-running relay (never killed unless forced)
 *   • 5s health probing with up/down transition tracking
 *   • auto-restart with exponential backoff after a crash
 *   • stdout/stderr piped into the log bus, lifecycle events in events.jsonl
 *
 * Exactly one instance exists per Node process (stored on globalThis so that
 * Next.js dev HMR does not leak child processes or timers).
 */

export class RelayLifecycleError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'RelayLifecycleError';
    this.code = code;
    this.details = details;
  }
}

export const FORCE_KILL_TOKEN = 'force-kill-external';

export interface StartResult {
  status: RelayStatus;
  alreadyRunning: boolean;
}

export interface StopOptions {
  force?: boolean;
  confirmToken?: string;
}

export class RelayManager {
  private state: RelayState = 'stopped';
  private child: ChildProcessWithoutNullStreams | null = null;
  private owned = false;
  private childPid: number | null = null;
  private startedAt: number | null = null;
  private restarts = 0;
  private consecutiveFailures = 0;
  private lastHealth: HealthProbe | null = null;
  private lastError: { at: string; message: string } | null = null;
  private readonly events = new RingBuffer<LifecycleEvent>(200);
  private backoffAttempt = 0;
  private restartsInWindow = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private starting = false;
  private spawnValues: RelayConfigValues | null = null;
  private spawnScript: string | null = null;
  private scriptHash: string | null = null;
  private listenInfo: { port: number | null; upstream: string | null } | null = null;
  private readonly emitter = new EventEmitter();
  private initialized = false;
  private portInUsePid: number | null = null;

  /* ── lifecycle of the manager itself ──────────────────────────────────── */

  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    ensureDataLayout();
    getLogBus().push({
      source: 'system',
      level: 'info',
      message: `Relay manager initialised (data dir: ${paths().dataDir})`,
    });

    // Subscribe to relay output for the "listening on" announcement.
    getLogBus().subscribe((entry) => {
      if (entry.source !== 'relay') return;
      const listen = parseListenLine(entry.message);
      if (listen) {
        this.listenInfo = listen;
        this.log('info', `Relay announced ${entry.message}`, { port: listen.port });
      }
    });

    // Adopt an already-running relay instead of fighting over the port.
    const port = await this.currentPort();
    const probe = await probeRelayHealth(port, env.healthTimeoutMs);
    if (probe.ok) {
      await this.markAdopted(probe, port);
    }

    this.startHealthLoop();
  }

  /** Stop probing and terminate a child we own (process shutdown). */
  async dispose(options: { killChild?: boolean } = {}): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopping = true;
    if (options.killChild && this.child && this.owned) {
      await this.terminateChild('panel shutdown');
    }
    this.initialized = false;
  }

  /* ── public API ───────────────────────────────────────────────────────── */

  async status(): Promise<RelayStatus> {
    const values = await this.effectiveValues();
    const port = Number.parseInt(values.POL_RELAY_PORT, 10) || 7179;
    const running = this.lastHealth?.ok === true;
    const script = await this.resolveScriptPath();
    if (script && this.scriptHash === null) {
      this.scriptHash = await sha256File(script);
    }
    return {
      state: this.state,
      running,
      healthy: running,
      owned: this.owned,
      pid: this.childPid,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      script,
      scriptSha256: this.scriptHash,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
      restarts: this.restarts,
      consecutiveFailures: this.consecutiveFailures,
      lastHealthAt: this.lastHealth?.at ?? null,
      lastHealthLatencyMs: this.lastHealth?.latencyMs ?? null,
      lastError: this.lastError,
      alreadyRunning: running,
      externalProcess: {
        detected: !this.owned && this.portInUsePid !== null,
        pid: this.portInUsePid,
        note: this.owned
          ? 'Relay process was spawned by the control panel.'
          : running
            ? 'Relay was already running when the panel started — the panel will not kill it.'
            : 'No relay process owned by the panel.',
      },
      config: {
        port,
        upstreamBase: values.POL_UPSTREAM_BASE,
        skipAuth: values.POL_SKIP_AUTH === 'true',
        hasApiKey: values.POL_API_KEY !== '',
        script: script ? path.basename(script) : 'pol_relay.py',
        pythonBin: env.pythonBin,
      },
      events: this.events.snapshot().slice(-20).reverse(),
    };
  }

  async start(): Promise<StartResult> {
    await this.ensureInit();
    const port = await this.currentPort();
    const probe = await probeRelayHealth(port, env.healthTimeoutMs);

    if (probe.ok) {
      this.lastHealth = probe;
      if (!this.owned) await this.markAdopted(probe, port);
      else this.state = 'running';
      return { status: await this.status(), alreadyRunning: true };
    }

    if (this.child && this.child.exitCode === null) {
      // Child alive but not answering yet — wait for readiness instead of
      // spawning a second process on the same port.
      const ready = await this.waitForReady(port, env.startTimeoutMs);
      if (ready) {
        this.state = 'running';
        return { status: await this.status(), alreadyRunning: true };
      }
    }

    const listening = await isPortListening(port);
    if (listening) {
      const pid = await findProcessOnPort(port);
      this.portInUsePid = pid;
      const message = `Port ${port} is already in use by another process${
        pid ? ` (pid ${pid})` : ''
      } that is not an OpenAI-compatible relay. Stop it or choose a different port in Config.`;
      this.setError(message);
      throw new RelayLifecycleError('port_in_use', message, { port, pid });
    }

    if (this.starting) {
      throw new RelayLifecycleError('conflict', 'The relay is already starting.');
    }

    this.starting = true;
    try {
      await this.spawnChild();
      this.state = 'running';
      const ready = await this.waitForReady(port, env.startTimeoutMs);
      if (!ready) {
        const message = `Relay process started (pid ${this.childPid}) but did not answer GET /v1/models within ${env.startTimeoutMs} ms.`;
        this.setError(message);
        this.event('error', message, { pid: this.childPid });
      } else {
        this.backoffAttempt = 0;
        this.restartsInWindow = 0;
      }
    } finally {
      this.starting = false;
    }

    return { status: await this.status(), alreadyRunning: false };
  }

  async stop(options: StopOptions = {}): Promise<RelayStatus> {
    await this.ensureInit();
    const port = await this.currentPort();
    const probe = await probeRelayHealth(port, env.healthTimeoutMs);

    if (!this.owned || !this.child) {
      const pid = this.portInUsePid ?? (await findProcessOnPort(port));
      this.portInUsePid = pid;
      if (!probe.ok && !pid) {
        this.state = 'stopped';
        this.event('stopped', 'Relay was already stopped.', { pid: null });
        return this.status();
      }
      if (!options.force) {
        throw new RelayLifecycleError(
          'forbidden',
          'This relay process is not owned by the panel. Use "Force kill external process" (double confirmation) to terminate it.',
          { pid },
        );
      }
      if (options.confirmToken !== FORCE_KILL_TOKEN) {
        throw new RelayLifecycleError(
          'forbidden',
          'Force-killing an external process requires the confirmation token.',
          { expected: FORCE_KILL_TOKEN },
        );
      }
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
          this.event('killed', `Sent SIGTERM to external process ${pid} on port ${port}.`, { pid });
        } catch (error) {
          const message = `Could not terminate pid ${pid}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          this.setError(message);
          throw new RelayLifecycleError('internal_error', message, { pid });
        }
      } else {
        this.event(
          'error',
          `The port ${port} is held by a process the panel cannot identify; nothing was terminated.`,
          { pid: null },
        );
      }
      this.portInUsePid = null;
      this.state = 'stopped';
      this.lastHealth = null;
      return this.status();
    }

    await this.terminateChild('stop requested');
    return this.status();
  }

  async restart(): Promise<RelayStatus> {
    await this.ensureInit();
    const wasOwned = this.owned && Boolean(this.child);
    const port = await this.currentPort();
    const probe = await probeRelayHealth(port, env.healthTimeoutMs);

    if (!wasOwned && probe.ok) {
      throw new RelayLifecycleError(
        'forbidden',
        'The running relay was not spawned by the panel — restart it from its own terminal or force-kill it first.',
        { port },
      );
    }
    if (wasOwned) {
      this.stopping = true;
      await this.terminateChild('restart requested');
      this.stopping = false;
    }
    this.restarts += 1;
    getMetrics().recordRestart();
    this.event('start_requested', 'Restart requested from the control panel.');
    const result = await this.start();
    return result.status;
  }

  async health(): Promise<HealthProbe> {
    const port = await this.currentPort();
    const probe = await probeRelayHealth(port, env.healthTimeoutMs);
    await this.applyHealth(probe, port);
    return probe;
  }

  /** Environment actually handed to the running relay (fallback: file values). */
  async effectiveValues(): Promise<RelayConfigValues> {
    if (this.spawnValues) return this.spawnValues;
    return getConfigStore().readValues();
  }

  /** Script the manager will execute (resolved + verified to exist). */
  async resolveScriptPath(): Promise<string | null> {
    if (this.spawnScript && existsSync(this.spawnScript)) return this.spawnScript;
    const explicit = envOptional('PANEL_RELAY_SCRIPT');
    const explicitFallback = envOptional('PANEL_RELAY_SCRIPT_FALLBACK');
    const candidates = explicit
      ? [
          // When the operator names a script we never silently substitute a
          // different file — a typo must surface as "not found".
          resolveFromPanel(explicit),
          ...(explicitFallback ? [resolveFromPanel(explicitFallback)] : []),
        ]
      : [
          resolveFromPanel(env.relayScript),
          resolveFromPanel(env.relayScriptFallback),
          path.join(path.dirname(resolveFromPanel(env.relayScript)), 'pol_relay.py'),
          path.join(resolveFromPanel('.'), '..', 'pol_relay.py'),
          '/app/pol_relay.py',
        ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Environment handed to the current child (empty when the relay was adopted). */
  spawnValuesSnapshot(): Partial<RelayConfigValues> | null {
    return this.spawnValues ? { ...this.spawnValues } : null;
  }

  subscribe(listener: (status: RelayStatus) => void): () => void {
    this.emitter.on('status', listener);
    return () => this.emitter.off('status', listener);
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  private async currentPort(): Promise<number> {
    const values = await this.effectiveValues();
    const parsed = Number.parseInt(values.POL_RELAY_PORT, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 7179;
  }

  private async spawnChild(): Promise<void> {
    const script = await this.resolveScriptPath();
    if (!script) {
      const message = `Relay script not found. Looked for "${env.relayScript}" and "${env.relayScriptFallback}" relative to the panel; set PANEL_RELAY_SCRIPT to an absolute path.`;
      this.setError(message);
      throw new RelayLifecycleError('not_found', message);
    }

    const values = await getConfigStore().readValues();
    const port = Number.parseInt(values.POL_RELAY_PORT, 10) || 7179;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      POL_RELAY_PORT: String(port),
      POL_UPSTREAM_BASE: values.POL_UPSTREAM_BASE,
      POL_SKIP_AUTH: values.POL_SKIP_AUTH,
      PYTHONUNBUFFERED: '1',
      ...(values.POL_API_KEY ? { POL_API_KEY: values.POL_API_KEY } : {}),
    };

    this.log('info', `Spawning relay: ${env.pythonBin} ${script} (port ${port})`, {
      upstream: values.POL_UPSTREAM_BASE,
      skipAuth: values.POL_SKIP_AUTH,
      hasKey: Boolean(values.POL_API_KEY),
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(env.pythonBin, [script], {
        env: childEnv,
        cwd: path.dirname(script),
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch (error) {
      const message = `Failed to spawn ${env.pythonBin}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.setError(message);
      throw new RelayLifecycleError('internal_error', message);
    }

    this.child = child;
    this.owned = true;
    this.stopping = false;
    this.childPid = child.pid ?? null;
    this.startedAt = Date.now();
    this.spawnValues = values;
    this.spawnScript = script;
    this.scriptHash = await sha256File(script);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      getLogBus().ingest('relay', chunk, 'info');
    });
    child.stderr?.on('data', (chunk: string) => {
      getLogBus().ingest('relay', chunk);
    });

    child.on('error', (error) => {
      const message = `Relay process error: ${error.message}`;
      this.setError(message);
      this.event('error', message, { pid: child.pid ?? null });
    });

    child.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });

    this.event('spawned', `Relay spawned with pid ${child.pid ?? 'unknown'} on port ${port}.`, {
      pid: child.pid ?? null,
      detail: { script, port },
    });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const pid = this.childPid;
    this.child = null;
    this.childPid = null;
    this.startedAt = null;
    this.lastHealth = null;

    const reason = signal ? `signal ${signalName(signal)}` : `exit code ${code}`;
    this.event('exited', `Relay process ${pid ?? ''} terminated (${reason}).`, {
      pid,
      detail: { code, signal },
    });

    if (this.stopping) {
      this.state = 'stopped';
      this.owned = false;
      this.emitStatus();
      return;
    }

    this.state = 'crashed';
    this.owned = false;
    const message = `Relay crashed (${reason}).`;
    this.log('error', message, { code, signal });
    this.scheduleRestart();
    this.emitStatus();
  }

  private scheduleRestart(): void {
    const maxAttempts = env.autoRestart;
    if (maxAttempts <= 0) {
      this.event('restart_exhausted', 'Auto-restart is disabled (PANEL_AUTORESTART=0).');
      return;
    }
    if (this.backoffAttempt >= maxAttempts) {
      this.event(
        'restart_exhausted',
        `Auto-restart gave up after ${maxAttempts} attempts. Start the relay manually from the dashboard.`,
      );
      return;
    }

    const delay = env.restartBackoffMs * 2 ** this.backoffAttempt;
    this.backoffAttempt += 1;
    this.restartsInWindow += 1;
    this.event(
      'restart_scheduled',
      `Restarting relay in ${delay} ms (attempt ${this.backoffAttempt}/${maxAttempts}).`,
      { detail: { delay, attempt: this.backoffAttempt } },
    );

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log('error', `Auto-restart failed: ${message}`);
        this.scheduleRestart();
      });
    }, delay);
  }

  private async terminateChild(reason: string): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      this.owned = false;
      this.lastHealth = null;
      return;
    }
    this.stopping = true;
    this.state = 'stopping';
    const pid = child.pid ?? null;
    const grace = env.shutdownGraceMs;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    try {
      child.kill('SIGTERM');
      this.log('info', `Sent SIGTERM to relay pid ${pid} (${reason})`);
    } catch (error) {
      this.log('warn', `SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), grace)),
    ]);

    if (timedOut) {
      this.log('warn', `Relay did not exit within ${grace} ms — sending SIGKILL`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      this.event('killed', `Relay pid ${pid} was force-killed after ${grace} ms.`, { pid });
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    }

    this.child = null;
    this.childPid = null;
    this.startedAt = null;
    this.owned = false;
    this.lastHealth = null;
    this.state = 'stopped';
    this.spawnValues = null;
    this.event('stopped', `Relay stopped (${reason}).`, { pid });
    this.emitStatus();
  }

  private startHealthLoop(): void {
    if (this.healthTimer) return;
    const interval = env.healthIntervalMs;
    this.healthTimer = setInterval(() => {
      void this.health().catch(() => undefined);
    }, interval);
    // Never hold the event loop open just for health checks.
    this.healthTimer.unref?.();
  }

  private async applyHealth(probe: HealthProbe, port: number): Promise<void> {
    const wasOk = this.lastHealth?.ok ?? false;
    this.lastHealth = probe;

    if (probe.ok) {
      this.consecutiveFailures = 0;
      if (!wasOk) {
        this.event('health_up', `Relay is answering /v1/models (${probe.latencyMs ?? '?'} ms).`);
        this.backoffAttempt = 0;
      }
      if (!this.owned) {
        if (this.state !== 'running') await this.markAdopted(probe, port);
        else this.state = 'running';
      } else if (this.state !== 'running') {
        this.state = 'running';
      }
      this.portInUsePid = null;
      this.emitStatus();
      return;
    }

    this.consecutiveFailures += 1;
    if (wasOk) {
      this.event('health_down', `Relay stopped answering /v1/models: ${probe.error ?? 'unknown error'}`);
      this.setError(probe.error ?? 'Relay health probe failed');
    }
    if (!this.owned && !this.child) {
      // Nothing to do; the relay is simply not running.
      if (this.state !== 'crashed' && this.state !== 'starting') this.state = 'stopped';
    }
    this.emitStatus();
  }

  private async markAdopted(probe: HealthProbe, port: number): Promise<void> {
    const firstAdoption = this.state !== 'running' || this.owned;
    this.state = 'running';
    this.owned = false;
    this.lastHealth = probe;
    this.startedAt = this.startedAt ?? Date.now();
    try {
      this.portInUsePid = await findProcessOnPort(port);
    } catch {
      this.portInUsePid = null;
    }
    if (firstAdoption) {
      this.event('adopted', 'Adopted an already-running relay on the configured port.', {
        pid: this.portInUsePid,
        detail: { latencyMs: probe.latencyMs, port },
      });
    }
  }

  private async waitForReady(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let delay = 150;
    while (Date.now() < deadline) {
      const probe = await probeRelayHealth(port, Math.min(1500, env.healthTimeoutMs));
      this.lastHealth = probe;
      if (probe.ok) {
        if (this.state !== 'running') {
          this.event('health_up', `Relay is answering /v1/models (${probe.latencyMs ?? '?'} ms).`);
        }
        this.state = 'running';
        this.emitStatus();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 800);
    }
    return false;
  }

  private setError(message: string): void {
    this.lastError = { at: new Date().toISOString(), message };
    this.log('error', message);
  }

  private event(kind: LifecycleEventKind, message: string, extra: Partial<LifecycleEvent> = {}): void {
    const event: LifecycleEvent = {
      at: new Date().toISOString(),
      kind,
      message,
      pid: this.childPid,
      ...extra,
    };
    this.events.push(event);
    void appendJsonl(paths().eventsJsonl, event).catch(() => undefined);
    this.log(kind === 'error' ? 'error' : 'info', `[lifecycle] ${message}`);
    this.emitStatus();
  }

  private log(level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>): void {
    getLogBus().push({
      source: 'system',
      level,
      message: detail ? `${message} ${JSON.stringify(detail)}` : message,
    });
  }

  private emitStatus(): void {
    this.emitter.emit('status', this);
  }

  /** Snapshot for the SSE status stream / status endpoint (no async fetch). */
  snapshotStatus(): Partial<RelayStatus> {
    return {
      state: this.state,
      running: this.lastHealth?.ok === true,
      healthy: this.lastHealth?.ok === true,
      owned: this.owned,
      pid: this.childPid,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
      restarts: this.restarts,
      consecutiveFailures: this.consecutiveFailures,
      lastHealthAt: this.lastHealth?.at ?? null,
      lastHealthLatencyMs: this.lastHealth?.latencyMs ?? null,
      lastError: this.lastError,
      events: this.events.snapshot().slice(-20).reverse(),
    };
  }

  get listenPort(): number | null {
    return this.listenInfo?.port ?? null;
  }

  get restartCountInWindow(): number {
    return this.restartsInWindow;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Singleton
 * ──────────────────────────────────────────────────────────────────────────── */

const GLOBAL_KEY = Symbol.for('zes.panel.relay-manager');

type GlobalWithManager = typeof globalThis & { [GLOBAL_KEY]?: RelayManager };

export function getRelayManager(): RelayManager {
  const scope = globalThis as GlobalWithManager;
  if (!scope[GLOBAL_KEY]) scope[GLOBAL_KEY] = new RelayManager();
  return scope[GLOBAL_KEY] as RelayManager;
}

/**
 * Drop the process-wide singleton.
 *
 * Any relay the panel spawned is terminated first — this is the hook used by
 * the test-suite and by process shutdown, and it must never leak a child
 * process that keeps holding the relay port.
 */
export async function resetRelayManager(): Promise<void> {
  const scope = globalThis as GlobalWithManager;
  const manager = scope[GLOBAL_KEY];
  if (manager) {
    await manager.dispose({ killChild: true });
    delete scope[GLOBAL_KEY];
  }
}
