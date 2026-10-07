#!/usr/bin/env node
/**
 * Demo upstream — an OpenAI-compatible mock used for offline development and
 * integration tests.
 *
 *   node tools/demo-upstream.mjs [--port 7189]
 *
 * It answers `GET /v1/models`, `POST /v1/chat/completions` (SSE when
 * `stream: true`) and echoes a deterministic canned answer so the whole chain
 * (panel → relay → upstream) can be exercised without network access.
 *
 * Nothing in the panel talks to this server unless you point POL_UPSTREAM_BASE
 * at it. The production default remains https://gen.pollinations.ai/v1.
 */

import http from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.DEMO_UPSTREAM_PORT ?? '7189' },
    host: { type: 'string', default: '127.0.0.1' },
    delay: { type: 'string', default: '35' },
  },
  allowPositionals: true,
});

const PORT = Number.parseInt(values.port ?? '7189', 10);
const HOST = values.host ?? '127.0.0.1';
const TOKEN_DELAY_MS = Number.parseInt(values.delay ?? '35', 10);

const MODELS = [
  { id: 'demo-openai', object: 'model', owned_by: 'demo', created: 1_700_000_000 },
  { id: 'demo-openai-fast', object: 'model', owned_by: 'demo', created: 1_700_000_000 },
  { id: 'demo-mistral', object: 'model', owned_by: 'demo', created: 1_700_000_000 },
  { id: 'demo-llama', object: 'model', owned_by: 'demo', created: 1_700_000_000 },
];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function answerFor(body) {
  const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
  const question = (lastUser?.content ?? 'nothing').toString().slice(0, 160);
  const model = body.model ?? 'demo-openai';
  return [
    `**${model}** here. You asked: “${question}”.`,
    '',
    'This response is produced by the local demo upstream, so the panel can be',
    'exercised end to end without contacting an external service. Streaming,',
    'token accounting, latency charts and the log tail all behave exactly as they',
    'do with a real OpenAI-compatible provider.',
  ].join('\n');
}

function usageFor(body, completion) {
  const prompt = JSON.stringify(body.messages ?? []).length / 4;
  const out = completion.length / 4;
  return {
    prompt_tokens: Math.max(1, Math.round(prompt)),
    completion_tokens: Math.max(1, Math.round(out)),
    total_tokens: Math.max(2, Math.round(prompt + out)),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return json(res, 200, { object: 'list', data: MODELS });
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } });
    }

    if (!body.model) {
      return json(res, 400, {
        error: { message: 'you must provide a model parameter', type: 'invalid_request_error' },
      });
    }

    const completion = answerFor(body);
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-demo-${Math.random().toString(36).slice(2, 10)}`;
    const usage = usageFor(body, completion);

    if (!body.stream) {
      return json(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: completion },
            finish_reason: 'stop',
          },
        ],
        usage,
      });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });

    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });

    const tokens = completion.match(/\s*\S+/g) ?? [];
    for (const token of tokens) {
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
      });
      await new Promise((resolve) => setTimeout(resolve, TOKEN_DELAY_MS));
    }

    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage,
    });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  return json(res, 404, { error: { message: `unknown route ${url.pathname}`, type: 'not_found' } });
});

server.listen(PORT, HOST, () => {
  console.log(
    `[demo-upstream] OpenAI-compatible mock listening on http://${HOST}:${PORT}/v1 ` +
      `(${MODELS.length} models, ${TOKEN_DELAY_MS}ms/token)`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[demo-upstream] ${signal} — closing`);
    server.close(() => process.exit(0));
  });
}
