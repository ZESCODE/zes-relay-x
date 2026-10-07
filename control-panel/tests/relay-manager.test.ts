import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@/server/bootstrap';
import { FORCE_KILL_TOKEN, RelayLifecycleError, getRelayManager, resetRelayManager } from '@/server/relay-manager';
import { getMetrics } from '@/server/metrics';
import { isPortListening } from '@/server/upstream';

/**
 * Relay manager tests.
 *
 * A tiny Python stand-in (`tests/fixtures/fake-relay.py`) plays the role of
 * pol_relay.py so spawn, adoption, health and shutdown can be exercised without
 * an upstream. Every test gets a fresh data directory and a free port.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'fake-relay.py');

const cleanups: Array<() => Promise<void> | void> = [];
const spawned: ChildProcess[] = [];
const createdDirs: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function setup(port: number): Promise<{ dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zes-relay-'));
  createdDirs.push(dir);
  process.env.PANEL_DATA_DIR = dir;
  process.env.PANEL_RELAY_SCRIPT = FIXTURE;
  process.env.PANEL_PYTHON_BIN = 'python3';
  process.env.PANEL_HEALTH_INTERVAL_MS = '400';
  process.env.PANEL_HEALTH_TIMEOUT_MS = '1500';
  process.env.PANEL_AUTORESTART = '0';
  process.env.PANEL_START_TIMEOUT_MS = '8000';
  process.env.PANEL_SHUTDOWN_GRACE_MS = '1500';
  process.env.PANEL_PANEL_LOG_MAX_BYTES = '0';
  await writeFile(
    path.join(dir, '.env'),
    `POL_RELAY_PORT=${port}\nPOL_UPSTREAM_BASE=http://127.0.0.1:1/v1\nPOL_SKIP_AUTH=true\nPOL_API_KEY=\n`,
    'utf8',
  );
  await resetRelayManager();
  // Wire the app's real plumbing (log bus → metrics) exactly as production
  // does. bootstrap() is idempotent across the whole test file.
  await bootstrap();
  return { dir };
}

function spawnFakeRelay(port: number): ChildProcess {
  const child = spawn('python3', [FIXTURE], {
    env: { ...process.env, POL_RELAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  return child;
}

async function waitForPort(port: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

afterEach(async () => {
  await resetRelayManager();
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const clean of cleanups.splice(0)) await clean();
  for (const key of [
    'PANEL_DATA_DIR',
    'PANEL_RELAY_SCRIPT',
    'PANEL_HEALTH_INTERVAL_MS',
    'PANEL_AUTORESTART',
    'PANEL_START_TIMEOUT_MS',
    'PANEL_SHUTDOWN_GRACE_MS',
    'PANEL_PANEL_LOG_MAX_BYTES',
  ]) {
    delete process.env[key];
  }
});

describe('RelayManager lifecycle', () => {
  it('starts the relay, becomes healthy, then stops it gracefully', async () => {
    const port = await freePort();
    await setup(port);
    const manager = getRelayManager();
    await manager.ensureInit();

    // Nothing is running yet ⇒ no adoption.
    const before = await manager.status();
    expect(before.running).toBe(false);
    expect(before.state).toBe('stopped');

    const started = await manager.start();
    expect(started.alreadyRunning).toBe(false);
    expect(started.status.owned).toBe(true);
    expect(started.status.pid).toBeGreaterThan(0);
    expect(started.status.healthy).toBe(true);
    expect(started.status.port).toBe(port);

    // The relay announced itself and its access lines reached the log bus.
    const events = started.status.events.map((event) => event.kind);
    expect(events).toContain('spawned');

    const stopped = await manager.stop();
    expect(stopped.owned).toBe(false);
    expect(stopped.running).toBe(false);
    expect(stopped.state).toBe('stopped');
    expect(await isPortListening(port)).toBe(false);
  }, 40_000);

  it('is idempotent: starting an already-running relay reports alreadyRunning', async () => {
    const port = await freePort();
    await setup(port);
    const manager = getRelayManager();
    await manager.start();

    const second = await manager.start();
    expect(second.alreadyRunning).toBe(true);
    expect(second.status.pid).toBeGreaterThan(0);
  }, 40_000);

  it('adopts an externally started relay and refuses to kill it', async () => {
    const port = await freePort();
    await setup(port);
    const external = spawnFakeRelay(port);
    expect(await waitForPort(port)).toBe(true);

    const manager = getRelayManager();
    await manager.ensureInit();
    await manager.health();
    const status = await manager.status();

    expect(status.owned).toBe(false);
    expect(status.running).toBe(true);
    expect(status.state).toBe('running');
    expect(status.events.some((event) => event.kind === 'adopted')).toBe(true);

    // Unforced stop must be refused.
    await expect(manager.stop()).rejects.toBeInstanceOf(RelayLifecycleError);
    await expect(manager.stop()).rejects.toThrow(/not owned by the panel/i);

    // Wrong token is refused too.
    await expect(manager.stop({ force: true, confirmToken: 'nope' })).rejects.toThrow(/confirmation token/i);

    // Correct token terminates the external process.
    const result = await manager.stop({ force: true, confirmToken: FORCE_KILL_TOKEN });
    expect(result.state).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(external.killed || external.exitCode !== null || !(await isPortListening(port))).toBe(true);
  }, 40_000);

  it('detects a foreign process holding the port', async () => {
    const port = await freePort();
    await setup(port);

    // A raw TCP listener that never speaks HTTP looks nothing like a relay.
    const blocker = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    });

    const manager = getRelayManager();
    await expect(manager.start()).rejects.toThrow(/already in use/i);
    const status = await manager.status();
    expect(status.lastError?.message).toMatch(/already in use/i);
  }, 30_000);

  it('surfaces a clear error when the relay script is missing', async () => {
    const port = await freePort();
    await setup(port);
    process.env.PANEL_RELAY_SCRIPT = path.join(here, 'does-not-exist.py');
    process.env.PANEL_RELAY_SCRIPT_FALLBACK = path.join(here, 'also-missing.sh');
    await resetRelayManager();

    const manager = getRelayManager();
    await expect(manager.start()).rejects.toThrow(/not found/i);
  }, 20_000);

  it('records relay access lines into the metrics while it runs', async () => {
    const port = await freePort();
    await setup(port);
    const manager = getRelayManager();
    await manager.start();

    const before = getMetrics().summary();

    // Ask the fake relay for its model list through the same path the panel uses.
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(response.ok).toBe(true);
    await response.text();

    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = getMetrics().summary();
    expect(after.relay.requestsObserved).toBeGreaterThan(before.relay.requestsObserved);
    expect(after.byEndpoint['/v1/models'] ?? 0).toBeGreaterThan(before.byEndpoint['/v1/models'] ?? 0);

    await manager.stop();
  }, 40_000);
});
