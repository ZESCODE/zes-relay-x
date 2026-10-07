/**
 * Secret redaction.
 *
 * Rule 1 of the build contract: never log the API key or the session secret.
 * Every log line, metric label and error body passes through `redactText`.
 */

const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const API_KEY_QUERY = /([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"']+/gi;
const JSON_SECRET = /("(?:api[_-]?key|apiKey|authorization|password|secret|token|sessionSecret)"\s*:\s*")([^"]*)(")/gi;
const ENV_SECRET = /^([A-Z0-9_]*(?:API_KEY|PASSWORD|SECRET|TOKEN|BEARER)[A-Z0-9_]*=)(.*)$/gim;
/** Common provider key shapes (sk-…, pk-…, gsk_…, pollinations …). */
const PROVIDER_KEY = /\b(sk|pk|gsk|rk)-[A-Za-z0-9_-]{12,}\b/g;
const HEX_SECRET = /\b[a-f0-9]{48,}\b/gi;

export const REDACTION_PLACEHOLDER = '***';

export function redactText(input: string): string {
  if (!input) return input;
  return input
    .replace(JSON_SECRET, `$1${REDACTION_PLACEHOLDER}$3`)
    .replace(BEARER, `$1 ${REDACTION_PLACEHOLDER}`)
    .replace(API_KEY_QUERY, `$1${REDACTION_PLACEHOLDER}`)
    .replace(ENV_SECRET, `$1${REDACTION_PLACEHOLDER}`)
    .replace(PROVIDER_KEY, (match, prefix: string) => `${prefix}-${REDACTION_PLACEHOLDER}`)
    .replace(HEX_SECRET, REDACTION_PLACEHOLDER);
}

const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'password',
  'passwd',
  'secret',
  'sessionsecret',
  'session_secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'privatekey',
]);

/** Deep-redact an object before it is logged or returned in an error body. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return redactText(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      out[key] = item ? REDACTION_PLACEHOLDER : item;
      continue;
    }
    out[key] = redactValue(item, depth + 1);
  }
  return out;
}

/** `sk-abcdef123456` → `sk-a…3456` — safe to display in the UI. */
export function maskSecret(value: string, keepStart = 4, keepEnd = 4): string {
  if (!value) return '';
  if (value.length <= keepStart + keepEnd) return REDACTION_PLACEHOLDER;
  return `${value.slice(0, keepStart)}…${value.slice(-keepEnd)}`;
}

/** True when the request carries an Authorization header (never read the value). */
export function hasAuthorizationHeader(headers: Headers): boolean {
  return Boolean(headers.get('authorization'));
}
