import type { ChatMessage, ChatParams, ChatRole } from '@/lib/types';
import { ApiHttpError } from './http';

/**
 * Validation for playground payloads and presets.
 *
 * The panel never rewrites the relay's wire format — it only guarantees that
 * whatever leaves the browser is well-formed before it is forwarded.
 */

export const DEFAULT_PARAMS: ChatParams = {
  model: '',
  temperature: 0.7,
  top_p: 1,
  max_tokens: null,
  presence_penalty: 0,
  frequency_penalty: 0,
  seed: null,
  stop: [],
  stream: true,
};

const ROLES: ChatRole[] = ['system', 'user', 'assistant'];
const MAX_MESSAGES = 100;
const MAX_CONTENT_CHARS = 200_000;
const MAX_STOP_SEQUENCES = 4;
const MAX_STOP_CHARS = 64;

export interface ChatPayload {
  model: string;
  messages: Array<{ role: ChatRole; content: string }>;
  params: ChatParams;
}

function fail(message: string, details?: unknown): never {
  throw new ApiHttpError('validation_failed', message, 422, details);
}

function numberIn(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) fail(`${label} must be a number.`);
  if (parsed < min || parsed > max) fail(`${label} must be between ${min} and ${max}.`);
  return parsed;
}

function optionalInt(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) fail(`${label} must be an integer.`);
  if (parsed < min || parsed > max) fail(`${label} must be between ${min} and ${max}.`);
  return Math.trunc(parsed);
}

export function parseMessages(raw: unknown): Array<{ role: ChatRole; content: string }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('At least one message is required.');
  }
  if (raw.length > MAX_MESSAGES) {
    fail(`Too many messages (max ${MAX_MESSAGES}).`);
  }
  const messages: Array<{ role: ChatRole; content: string }> = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') fail(`Message ${index} must be an object.`);
    const record = item as Record<string, unknown>;
    const role = record.role;
    if (typeof role !== 'string' || !ROLES.includes(role as ChatRole)) {
      fail(`Message ${index} has an invalid role (expected system, user or assistant).`);
    }
    const content = record.content;
    if (typeof content !== 'string') fail(`Message ${index} content must be a string.`);
    if (content.length > MAX_CONTENT_CHARS) {
      fail(`Message ${index} exceeds ${MAX_CONTENT_CHARS} characters.`);
    }
    if (content.trim() === '' && (role === 'user' || role === 'system')) {
      fail(`Message ${index} (${role}) is empty.`);
    }
    messages.push({ role: role as ChatRole, content });
  });
  return messages;
}

export function parseParams(raw: unknown, defaults: ChatParams = DEFAULT_PARAMS): ChatParams {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const model = record.model === undefined || record.model === null ? defaults.model : String(record.model).trim();
  if (model.length > 200) fail('Model id is too long.');
  const stopRaw = record.stop;
  let stop: string[] = defaults.stop;
  if (Array.isArray(stopRaw)) {
    if (stopRaw.length > MAX_STOP_SEQUENCES) fail(`At most ${MAX_STOP_SEQUENCES} stop sequences are allowed.`);
    stop = stopRaw.map((value, index) => {
      if (typeof value !== 'string') fail(`Stop sequence ${index} must be a string.`);
      if (value.length > MAX_STOP_CHARS) fail(`Stop sequence ${index} exceeds ${MAX_STOP_CHARS} characters.`);
      return value;
    });
    stop = stop.filter((value) => value !== '');
  } else if (typeof stopRaw === 'string' && stopRaw.trim() !== '') {
    stop = [stopRaw.trim()];
  }

  return {
    model,
    temperature: numberIn(record.temperature, defaults.temperature, 0, 2, 'temperature'),
    top_p: numberIn(record.top_p, defaults.top_p, 0, 1, 'top_p'),
    max_tokens: optionalInt(record.max_tokens, 1, 1_000_000, 'max_tokens'),
    presence_penalty: numberIn(
      record.presence_penalty,
      defaults.presence_penalty,
      -2,
      2,
      'presence_penalty',
    ),
    frequency_penalty: numberIn(
      record.frequency_penalty,
      defaults.frequency_penalty,
      -2,
      2,
      'frequency_penalty',
    ),
    seed: optionalInt(record.seed, 0, 2_147_483_647, 'seed'),
    stop,
    stream: record.stream === undefined ? defaults.stream : Boolean(record.stream),
  };
}

export function parseChatPayload(raw: unknown): ChatPayload {
  if (!raw || typeof raw !== 'object') {
    throw new ApiHttpError('bad_request', 'Request body must be a JSON object.', 400);
  }
  const record = raw as Record<string, unknown>;
  const messages = parseMessages(record.messages);
  const params = parseParams(record.params ?? record);

  if (!params.model) {
    fail('A model id is required — pick one in the playground.', { field: 'model' });
  }
  return { model: params.model, messages, params };
}

/** Build the OpenAI-compatible request forwarded to the relay. */
export function toUpstreamBody(payload: ChatPayload): Record<string, unknown> {
  const { params, messages, model } = payload;
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: params.stream,
    temperature: params.temperature,
    top_p: params.top_p,
    presence_penalty: params.presence_penalty,
    frequency_penalty: params.frequency_penalty,
  };
  if (params.max_tokens !== null) body.max_tokens = params.max_tokens;
  if (params.seed !== null) body.seed = params.seed;
  if (params.stop.length > 0) body.stop = params.stop;
  return body;
}

export function messageIdFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `m${counter}-${Math.random().toString(36).slice(2, 8)}`;
  };
}

export type { ChatMessage };
