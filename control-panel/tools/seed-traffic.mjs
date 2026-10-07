#!/usr/bin/env node
/**
 * Seed traffic — drives real requests through the panel so the dashboard has
 * meaningful metrics to display (no synthetic/fake data is ever injected).
 *
 *   node tools/seed-traffic.mjs --count 24 --base http://127.0.0.1:3000 \
 *        --user admin --password '…'
 *
 * Flow: sign in (cookie jar) → GET /api/models → POST /api/chat N times with a
 * mix of streaming/non-streaming calls and a couple of invalid payloads so the
 * error feed and status breakdown are populated too. Respects the panel's chat
 * rate limit by pacing requests (default 1.1s apart).
 */

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: process.env.PANEL_BASE ?? 'http://127.0.0.1:3000' },
    user: { type: 'string', default: process.env.PANEL_ADMIN_USER ?? 'admin' },
    password: { type: 'string', default: process.env.PANEL_ADMIN_PASSWORD ?? '' },
    count: { type: 'string', default: '24' },
    delay: { type: 'string', default: '1100' },
    'include-errors': { type: 'boolean', default: true },
  },
  allowPositionals: true,
});

const BASE = (values.base ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const COUNT = Number.parseInt(values.count ?? '24', 10);
const DELAY_MS = Number.parseInt(values.delay ?? '1100', 10);
const INCLUDE_ERRORS = values['include-errors'] !== false;

const jar = new Map();

function rememberCookies(response) {
  const header = response.headers.getSetCookie?.() ?? [];
  for (const cookie of header) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (index === -1) continue;
    jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (jar.size > 0) headers.set('cookie', cookieHeader());
  if (init.body) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && jar.has('zes_csrf')) {
    headers.set('x-csrf-token', jar.get('zes_csrf'));
  }
  const response = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
  rememberCookies(response);
  return response;
}

async function readEnvelope(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400) };
  }
}

const PROMPTS = [
  'Summarise the purpose of an OpenAI-compatible relay in one sentence.',
  'List three things a control panel should show for a proxy service.',
  'Explain streaming responses to a new engineer.',
  'Write a haiku about observability.',
  'What is the difference between p50 and p99 latency?',
  'Give me a checklist for rotating an upstream API key.',
  'Describe how SSE differs from WebSockets in two bullets.',
  'Suggest a naming convention for log sources in a dashboard.',
  'What should a health probe check?',
  'Explain exponential backoff in one paragraph.',
];

async function main() {
  console.log(`[seed] signing in to ${BASE} as ${values.user}`);
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: values.user, password: values.password }),
  });
  const loginBody = await readEnvelope(login);
  if (!login.ok) {
    console.error(`[seed] login failed (${login.status}):`, loginBody?.error?.message ?? loginBody);
    console.error('[seed] pass --password (or PANEL_ADMIN_PASSWORD) with the admin password.');
    process.exit(1);
  }
  console.log('[seed] signed in');

  const modelsResponse = await request('/api/models');
  const modelsBody = await readEnvelope(modelsResponse);
  const models = (modelsBody?.data?.models ?? []).map((model) => model.id);
  if (models.length === 0) {
    console.warn('[seed] no models reported by the relay — is it running?');
  }
  console.log(`[seed] ${models.length} model(s): ${models.slice(0, 5).join(', ')}`);

  let ok = 0;
  let errors = 0;

  for (let index = 0; index < COUNT; index += 1) {
    const model = models[index % Math.max(models.length, 1)] ?? 'demo-openai';
    const stream = index % 4 !== 3;
    const prompt = PROMPTS[index % PROMPTS.length];
    const payload = {
      model,
      messages: [
        { role: 'system', content: 'You are a terse assistant used for load seeding.' },
        { role: 'user', content: prompt },
      ],
      params: {
        model,
        stream,
        temperature: 0.4 + (index % 5) * 0.1,
        top_p: 1,
        max_tokens: 120,
        presence_penalty: 0,
        frequency_penalty: 0,
        seed: 1000 + index,
        stop: [],
      },
    };

    const response = await request('/api/chat', { method: 'POST', body: JSON.stringify(payload) });
    if (response.ok) {
      // Drain the stream so the request completes and metrics are finalised.
      const text = await response.text();
      ok += 1;
      process.stdout.write(
        `[seed] ${index + 1}/${COUNT} ${model} ${stream ? 'stream' : 'json'} → ${response.status} (${text.length} bytes)\n`,
      );
    } else {
      errors += 1;
      const body = await readEnvelope(response);
      process.stdout.write(
        `[seed] ${index + 1}/${COUNT} ${model} → ${response.status} ${body?.error?.message ?? ''}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  if (INCLUDE_ERRORS) {
    const invalid = await request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'no model here' }] }),
    });
    await readEnvelope(invalid);
    console.log(`[seed] validation probe → ${invalid.status} (expected 422)`);
  }

  const summary = await request('/api/metrics/summary');
  const body = await readEnvelope(summary);
  const counters = body?.data?.counters;
  console.log(
    `[seed] done — ${ok} ok, ${errors} failed. Panel counters: ${counters?.requestsTotal ?? '?'} requests, ` +
      `${counters?.tokensCompletion ?? '?'} completion tokens, p95 ${body?.data?.latency?.p95 ?? '?'} ms`,
  );
}

main().catch((error) => {
  console.error('[seed] failed:', error);
  process.exit(1);
});
