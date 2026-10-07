import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSseParser } from '@/lib/sse';

/**
 * End-to-end integration test.
 *
 * Spins up:
 *   1. `tools/demo-upstream.mjs` — an OpenAI-compatible mock (no network);
 *   2. the **real** `pol_relay.py` via the panel's RelayManager;
 * then asserts an actual chat-completion round trip through the relay,
 * including streaming, token usage and the access log the panel parses.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const panelRoot = path.resolve(here, '..');
const repoRoot = path.resolve(panelRoot, '..');
const RELAY_SCRIPT = path.join(repoRoot, 'pol_relay.py');
const DEMO_UPSTREAM = path.join(panelRoot, 'tools', 'demo-upstream.mjs');

const children: ChildProcess[] = [];
let dataDir: string;
let relayPort = 0;
let upstreamPort = 0;

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

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

beforeAll(async () => {
  relayPort = await freePort();
  upstreamPort = await freePort();
  dataDir = await mkdtemp(path.join(tmpdir(), 'zes-integration-'));

  const upstream = spawn(
    process.execPath,
    [DEMO_UPSTREAM, '--port', String(upstreamPort), '--delay', '8'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(upstream);
  const upstreamReady = await waitForHttp(`http://127.0.0.1:${upstreamPort}/v1/models`);
  if (!upstreamReady) throw new Error('demo upstream did not start');

  process.env.PANEL_DATA_DIR = dataDir;
  process.env.PANEL_RELAY_SCRIPT = RELAY_SCRIPT;
  process.env.PANEL_PYTHON_BIN = process.env.PANEL_PYTHON_BIN ?? 'python3';
  process.env.PANEL_HEALTH_INTERVAL_MS = '500';
  process.env.PANEL_HEALTH_TIMEOUT_MS = '2000';
  process.env.PANEL_AUTORESTART = '0';
  process.env.PANEL_PANEL_LOG_MAX_BYTES = '0';
  process.env.POL_SKIP_AUTH = 'true';

  await writeFile(
    path.join(dataDir, '.env'),
    [
      `POL_RELAY_PORT=${relayPort}`,
      `POL_UPSTREAM_BASE=http://127.0.0.1:${upstreamPort}/v1`,
      'POL_SKIP_AUTH=true',
      'POL_API_KEY=',
      '',
    ].join('\n'),
    'utf8',
  );

  // Real wiring: log bus → metrics, metrics timers, relay manager init.
  const { bootstrap } = await import('@/server/bootstrap');
  await bootstrap();

  const { getRelayManager } = await import('@/server/relay-manager');
  const manager = getRelayManager();
  await manager.ensureInit();
  const started = await manager.start();
  if (!started.status.healthy) {
    throw new Error(`relay did not become healthy: ${started.status.lastError?.message ?? 'unknown'}`);
  }
}, 60_000);

afterAll(async () => {
  const { resetRelayManager } = await import('@/server/relay-manager');
  await resetRelayManager();
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  for (const key of [
    'PANEL_DATA_DIR',
    'PANEL_RELAY_SCRIPT',
    'PANEL_HEALTH_INTERVAL_MS',
    'PANEL_HEALTH_TIMEOUT_MS',
    'PANEL_AUTORESTART',
    'PANEL_PANEL_LOG_MAX_BYTES',
    'POL_SKIP_AUTH',
  ]) {
    delete process.env[key];
  }
});

describe('relay round trip (panel → pol_relay.py → upstream)', () => {
  it('serves GET /v1/models from the relay', async () => {
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.map((model) => model.id)).toContain('demo-openai');
  }, 20_000);

  it('completes a non-streaming chat round trip with usage', async () => {
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'demo-openai',
        messages: [{ role: 'user', content: 'integration test please' }],
        stream: false,
        max_tokens: 64,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as {
      id: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices[0]?.message.content).toContain('demo-openai');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  }, 20_000);

  it('streams SSE chunks and terminates with [DONE]', async () => {
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'demo-openai-fast',
        messages: [{ role: 'user', content: 'stream me' }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.body).toBeTruthy();

    const parser = createSseParser();
    const decoder = new TextDecoder();
    let content = '';
    let sawDone = false;
    let usage: { total_tokens?: number } | null = null;
    let firstChunkAt = 0;
    const started = Date.now();

    // Read the body incrementally — this proves the relay streams rather than
    // buffering the whole response.
    const reader = response.body!.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (firstChunkAt === 0 && event.data !== '[DONE]') firstChunkAt = Date.now() - started;
        if (event.data === '[DONE]') {
          sawDone = true;
          continue;
        }
        const chunk = JSON.parse(event.data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { total_tokens?: number } | null;
        };
        content += chunk.choices?.[0]?.delta?.content ?? '';
        if (chunk.usage) usage = chunk.usage;
      }
      if (sawDone) break;
    }

    expect(content.length).toBeGreaterThan(10);
    expect(sawDone).toBe(true);
    expect(usage?.total_tokens).toBeGreaterThan(0);
    expect(firstChunkAt).toBeLessThan(3000);
  }, 30_000);

  it('returns an OpenAI-shaped error for an unknown route', async () => {
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/nope`, { method: 'POST' });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  }, 15_000);

  it('records the relay access log into the panel metrics', async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { getMetrics } = await import('@/server/metrics');
    const summary = getMetrics().summary();
    expect(summary.relay.requestsObserved).toBeGreaterThan(0);
    expect(summary.byEndpoint['/v1/chat/completions']).toBeGreaterThan(0);
    expect(summary.latency.count).toBeGreaterThan(0);
  }, 15_000);

  it('reports relay status with a matching script hash', async () => {
    const { getRelayManager } = await import('@/server/relay-manager');
    const status = await getRelayManager().status();
    expect(status.running).toBe(true);
    expect(status.owned).toBe(true);
    expect(status.script).toBe(RELAY_SCRIPT);
    expect(status.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 15_000);
});
