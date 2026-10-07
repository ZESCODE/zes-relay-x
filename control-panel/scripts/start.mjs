#!/usr/bin/env node
/**
 * Safe launcher for `next dev` / `next start`.
 *
 * Why not call Next directly? Because the panel must refuse to listen on a
 * public interface unless the operator explicitly opts in
 * (`PANEL_ALLOW_PUBLIC=true`). Next's own `-H` flag has no such guard, and this
 * script also validates the port before any child process is created.
 *
 * Usage:  node scripts/start.mjs [--dev] [--port N] [--host H]
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/**
 * Minimal .env loader (same precedence as Next: real environment wins, then
 * `.env.local`, then `.env`). Loading it here as well means the host/port guard
 * below sees the very same configuration the app will run with.
 */
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

for (const file of ['.env.local', `.env.${process.env.NODE_ENV ?? 'development'}`, '.env']) {
  loadEnvFile(path.join(root, file));
}

const args = process.argv.slice(2);
const dev = args.includes('--dev') || process.env.PANEL_MODE === 'dev';

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const host = readArg('--host') ?? process.env.PANEL_HOST?.trim() ?? '127.0.0.1';
const portRaw = readArg('--port') ?? process.env.PANEL_PORT?.trim() ?? '3000';
const allowPublic = ['1', 'true', 'yes', 'on'].includes(
  (process.env.PANEL_ALLOW_PUBLIC ?? 'false').toLowerCase(),
);

const port = Number.parseInt(portRaw, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[panel] PANEL_PORT must be an integer between 1 and 65535 (received "${portRaw}").`);
  process.exit(1);
}

if (!LOOPBACK.has(host) && !allowPublic) {
  console.error(
    [
      '',
      `[panel] Refusing to bind ${host}:${port}.`,
      '',
      '  The control panel can start/stop processes and read data/.env, so it',
      '  must not be reachable from the network by accident.',
      '',
      '  Options:',
      '    • bind loopback (default):            PANEL_HOST=127.0.0.1',
      '    • put it behind a proxy you control:  PANEL_HOST=0.0.0.0 PANEL_ALLOW_PUBLIC=true',
      '    • keep it private and tunnel it:      ssh -L 3000:127.0.0.1:3000 user@host',
      '',
      '  When exposing the panel, also set PANEL_SESSION_SECRET and serve it over',
      '  HTTPS (the session cookie is marked Secure automatically).',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const command = dev ? 'dev' : 'start';
const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

const env = {
  ...process.env,
  NODE_ENV: dev ? 'development' : 'production',
  PANEL_HOST: host,
  PANEL_PORT: String(port),
  PANEL_ALLOW_PUBLIC: allowPublic ? 'true' : 'false',
};

console.log(
  `[panel] starting ${command} on http://${host}:${port}${allowPublic ? ' (public bind allowed)' : ''}`,
);
if (!dev && process.env.PANEL_ALLOW_PUBLIC === 'true' && !process.env.PANEL_SESSION_SECRET) {
  console.warn(
    '[panel] warning: public bind without PANEL_SESSION_SECRET — sessions use the generated file secret.',
  );
}

const child = spawn(process.execPath, [nextBin, command, '-H', host, '-p', String(port)], {
  cwd: root,
  env,
  stdio: 'inherit',
});

const forward = (signal) => () => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
process.on('SIGHUP', forward('SIGHUP'));

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`[panel] stopped by ${signal}`);
    process.exit(0);
  }
  process.exit(code ?? 0);
});
