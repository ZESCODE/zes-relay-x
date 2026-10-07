#!/usr/bin/env node
/**
 * Source bundler — emits one markdown document containing the README, every
 * source file in BUILD-PROMPT order, and a final "How to run" section.
 *
 *   node tools/bundle.mjs [--out DELIVERABLE.md]
 *
 * The document is generated on demand and is gitignored on purpose: the files
 * in this repository are the source of truth, the bundle is a review copy.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelRoot = path.resolve(here, '..');
const repoRoot = path.resolve(panelRoot, '..');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outFile = path.resolve(
  panelRoot,
  outIndex !== -1 && args[outIndex + 1] ? args[outIndex + 1] : 'DELIVERABLE.md',
);

const LANG_BY_EXT = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.mjs': 'js',
  '.js': 'js',
  '.py': 'python',
  '.json': 'json',
  '.css': 'css',
  '.md': 'md',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.svg': 'xml',
};

function listFiles(relativeDir) {
  const dir = path.join(repoRoot, relativeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => ({
      file: `${relativeDir}/${name}`,
      lang: LANG_BY_EXT[path.extname(name)] ?? 'text',
    }));
}

function listRoutes() {
  const apiDir = path.join(panelRoot, 'src', 'app', 'api');
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'route.ts') {
        found.push({
          file: path.relative(repoRoot, full).split(path.sep).join('/'),
          lang: 'ts',
        });
      }
    }
  };
  if (existsSync(apiDir)) walk(apiDir);
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

const config = (file, lang = LANG_BY_EXT[path.extname(file)] ?? 'text') => ({ file, lang });

const ORDER = [
  { file: 'README.md', lang: 'md' },
  config('.gitignore'),
  config('.dockerignore'),
  config('pol_relay.py', 'python'),
  config('pol-relay.sh', 'bash'),

  config('control-panel/package.json'),
  config('control-panel/tsconfig.json'),
  config('control-panel/next.config.mjs'),
  config('control-panel/tailwind.config.ts'),
  config('control-panel/postcss.config.mjs'),
  config('control-panel/vitest.config.ts'),
  config('control-panel/.eslintrc.json'),
  config('control-panel/.env.example', 'bash'),
  config('control-panel/.gitignore'),
  config('control-panel/src/middleware.ts'),
  config('control-panel/scripts/start.mjs'),

  config('control-panel/src/lib/types.ts'),
  config('control-panel/src/lib/format.ts'),
  config('control-panel/src/lib/sse.ts'),
  config('control-panel/src/lib/api.ts'),
  ...listFiles('control-panel/src/lib/hooks'),

  config('control-panel/src/server/env.ts'),
  config('control-panel/src/server/fs-paths.ts'),
  config('control-panel/src/server/ring-buffer.ts'),
  config('control-panel/src/server/redact.ts'),
  config('control-panel/src/server/relay-log-parser.ts'),
  config('control-panel/src/server/log-bus.ts'),
  config('control-panel/src/server/metrics.ts'),
  config('control-panel/src/server/upstream.ts'),
  config('control-panel/src/server/relay-manager.ts'),
  config('control-panel/src/server/config-store.ts'),
  config('control-panel/src/server/preset-store.ts'),
  config('control-panel/src/server/token-store.ts'),
  config('control-panel/src/server/auth.ts'),
  config('control-panel/src/server/session-token.ts'),
  config('control-panel/src/server/session-verify.ts'),
  config('control-panel/src/server/rate-limit.ts'),
  config('control-panel/src/server/http.ts'),
  config('control-panel/src/server/chat-payload.ts'),
  config('control-panel/src/server/zip.ts'),
  config('control-panel/src/server/backup.ts'),
  config('control-panel/src/server/system.ts'),
  config('control-panel/src/server/sse-server.ts'),
  config('control-panel/src/server/bootstrap.ts'),
  config('control-panel/src/server/signals.ts'),

  ...listRoutes(),

  config('control-panel/src/app/layout.tsx'),
  config('control-panel/src/app/page.tsx'),
  config('control-panel/src/app/error.tsx'),
  config('control-panel/src/app/not-found.tsx'),
  config('control-panel/src/app/globals.css'),
  config('control-panel/src/app/icon.svg', 'xml'),
  config('control-panel/src/app/login/page.tsx'),
  config('control-panel/src/app/(panel)/layout.tsx'),
  config('control-panel/src/app/(panel)/loading.tsx'),
  config('control-panel/src/app/(panel)/dashboard/page.tsx'),
  config('control-panel/src/app/(panel)/playground/page.tsx'),
  config('control-panel/src/app/(panel)/logs/page.tsx'),
  config('control-panel/src/app/(panel)/config/page.tsx'),
  config('control-panel/src/app/(panel)/admin/page.tsx'),

  ...listFiles('control-panel/src/components/ui'),
  ...listFiles('control-panel/src/components/charts'),
  ...listFiles('control-panel/src/components/layout'),
  ...listFiles('control-panel/src/components/dashboard'),
  ...listFiles('control-panel/src/components/chat'),
  ...listFiles('control-panel/src/components/logs'),
  ...listFiles('control-panel/src/components/config'),
  ...listFiles('control-panel/src/components/admin'),

  config('control-panel/tools/demo-upstream.mjs'),
  config('control-panel/tools/seed-traffic.mjs'),
  config('control-panel/tools/bundle.mjs'),

  config('control-panel/tests/auth.test.ts'),
  config('control-panel/tests/metrics.test.ts'),
  config('control-panel/tests/relay-manager.test.ts'),
  config('control-panel/tests/relay-integration.test.ts'),
  config('control-panel/tests/fixtures/fake-relay.py', 'python'),

  config('control-panel/Dockerfile', 'dockerfile'),
  config('control-panel/docker-compose.yml', 'yaml'),
];

/** Fence content with enough backticks that inner fences cannot break out. */
function fence(content, lang) {
  const inner = content
    .split('\n')
    .filter((line) => /^\s*`{3,}/.test(line))
    .map((line) => line.match(/`+/)?.[0].length ?? 3);
  const ticks = '`'.repeat(Math.max(3, ...inner.map((length) => length + 1)));
  return `${ticks}${lang}\n${content.replace(/\s+$/, '')}\n${ticks}`;
}

const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const howToRunIndex = readme.indexOf('## How to run');
const readmeIntro = (howToRunIndex === -1 ? readme : readme.slice(0, howToRunIndex)).trimEnd();
const howToRun =
  howToRunIndex === -1
    ? '## How to run\n\nSee the quick start in the README above.'
    : readme.slice(howToRunIndex).split(/\n## (?!#)/)[0].trimEnd();

const parts = [readmeIntro, '---', '# Source files', ''];
const missing = [];

for (const entry of ORDER) {
  const full = path.join(repoRoot, entry.file);
  if (!existsSync(full)) {
    missing.push(entry.file);
    continue;
  }
  parts.push(`### ${entry.file}`, '', fence(readFileSync(full, 'utf8'), entry.lang), '');
}

parts.push('---', '', howToRun, '');

const document = `${parts.join('\n').replace(/\n{4,}/g, '\n\n\n')}\n`;
writeFileSync(outFile, document, 'utf8');

const kb = (Buffer.byteLength(document, 'utf8') / 1024).toFixed(1);
console.log(
  `[bundle] ${path.relative(process.cwd(), outFile)} — ${kb} KB, ${ORDER.length - missing.length} files`,
);
if (missing.length > 0) {
  console.warn(`[bundle] skipped ${missing.length} missing file(s): ${missing.join(', ')}`);
}
