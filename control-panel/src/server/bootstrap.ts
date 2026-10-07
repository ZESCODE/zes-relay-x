import { setRunningValuesProvider } from './config-store';
import { env } from './env';
import { ensureDataLayout, paths } from './fs-paths';
import { getLogBus } from './log-bus';
import { getMetrics } from './metrics';
import { getRelayManager, type RelayManager } from './relay-manager';

/**
 * One-time process bootstrap.
 *
 * Triggered lazily by the first Node-runtime request (`route()` and the panel
 * layout call `ensureBootstrapped()`), so it runs exactly once per process
 * without touching the edge runtime:
 *   • create the data layout (mode 0700)
 *   • restore persisted metrics counters
 *   • create the admin account on first run
 *   • start the relay manager (health loop + adoption probe)
 *   • tick/flush metrics on a timer
 *   • terminate an owned relay when the panel exits
 */

interface BootstrapState {
  startedAt: number;
  metricsTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  signalHandlersInstalled: boolean;
}

const GLOBAL_KEY = Symbol.for('zes.panel.bootstrap');

type GlobalWithBootstrap = typeof globalThis & { [GLOBAL_KEY]?: BootstrapState };

async function ensureAdminSafely(): Promise<void> {
  try {
    const { ensureAdmin } = await import('./auth');
    await ensureAdmin();
  } catch (error) {
    getLogBus().push({
      source: 'system',
      level: 'error',
      message: `Failed to prepare the admin account: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

let bootstrapPromise: Promise<void> | null = null;

/**
 * Run `bootstrap()` at most once per process.
 *
 * Called by every Node route handler (through `route()`), by the panel layout
 * and explicitly by the test-suite. A failure is logged — and *not* cached —
 * so the next request can retry instead of leaving the panel permanently
 * half-initialised.
 */
export function ensureBootstrapped(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrap().catch((error: unknown) => {
      bootstrapPromise = null;
      getLogBus().push({
        source: 'system',
        level: 'error',
        message: `Panel bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      if (process.env.NODE_ENV !== 'production') {
        console.error('[panel] bootstrap failed', error);
      }
    });
  }
  return bootstrapPromise;
}

export async function bootstrap(): Promise<void> {
  const scope = globalThis as GlobalWithBootstrap;
  if (scope[GLOBAL_KEY]) return;

  const state: BootstrapState = {
    startedAt: Date.now(),
    metricsTimer: null,
    flushTimer: null,
    signalHandlersInstalled: false,
  };
  scope[GLOBAL_KEY] = state;

  const layout = ensureDataLayout();
  const logBus = getLogBus();
  const metrics = getMetrics();

  logBus.push({
    source: 'system',
    level: 'info',
    message: `Panel ${env.panelVersion} starting — Node ${process.version}, data dir ${layout.dataDir}`,
  });

  await metrics.hydrate();

  // The relay's stderr is the only place traffic that *bypasses* the panel is
  // visible: every parsed access line is folded into the metrics. Records the
  // panel already accounted for carry the same `rid` and are de-duplicated.
  logBus.subscribe((entry) => {
    if (!entry.request) return;
    try {
      metrics.recordRelayAccess({
        ...entry.request,
        at: entry.request.at ?? entry.at,
        requestId: entry.request.requestId ?? null,
      });
    } catch {
      metrics.recordParseWarning();
    }
  });

  const manager: RelayManager = getRelayManager();

  // The config page diffs saved values against the environment the relay
  // process actually received when it was spawned.
  setRunningValuesProvider(() => manager.spawnValuesSnapshot());

  await ensureAdminSafely();
  await manager.ensureInit();

  // Metrics tick (5s samples) — keeps live sparklines flowing.
  state.metricsTimer = setInterval(() => {
    try {
      metrics.tick();
    } catch {
      /* never let a metrics tick break the process */
    }
  }, env.metricsTickMs);
  state.metricsTimer.unref?.();

  // Persist counters every 30s and once shortly after boot.
  state.flushTimer = setInterval(() => {
    void metrics.flush();
  }, 30_000);
  state.flushTimer.unref?.();

  if (!state.signalHandlersInstalled) {
    state.signalHandlersInstalled = true;
    const shutdown = (signal: NodeJS.Signals): void => {
      getLogBus().push({
        source: 'system',
        level: 'warn',
        message: `Received ${signal} — shutting down the panel.`,
      });
      void manager
        .dispose({ killChild: true })
        .then(() => metrics.flush(true))
        .catch(() => undefined)
        .finally(() => {
          if (signal !== 'SIGUSR2') process.exit(0);
        });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGUSR2', shutdown); // nodemon/tsx restart signal
  }

  logBus.push({
    source: 'system',
    level: 'info',
    message: `Bootstrap complete in ${Date.now() - state.startedAt} ms (pid ${process.pid}).`,
  });

  void paths();
}

/** Test/shutdown helper — stops timers without touching the relay process. */
export async function teardownBootstrap(): Promise<void> {
  const scope = globalThis as GlobalWithBootstrap;
  const state = scope[GLOBAL_KEY];
  if (!state) return;
  if (state.metricsTimer) clearInterval(state.metricsTimer);
  if (state.flushTimer) clearInterval(state.flushTimer);
  delete scope[GLOBAL_KEY];
}

export function bootstrapState(): BootstrapState | null {
  const scope = globalThis as GlobalWithBootstrap;
  return scope[GLOBAL_KEY] ?? null;
}
