/** @type {import('next').NextConfig} */

// ── Framing policy ──────────────────────────────────────────────────────────
// The panel ships locked down (X-Frame-Options: DENY). Embedding is only
// enabled when the operator explicitly opts in, because the reference
// deployment runs behind a trusted reverse proxy / preview host.
const frameAncestors = process.env.PANEL_FRAME_ANCESTORS?.trim();
const embeddable = process.env.PANEL_EMBEDDABLE === 'true' || Boolean(frameAncestors);

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

if (!embeddable) {
  securityHeaders.push({ key: 'X-Frame-Options', value: 'DENY' });
}

/**
 * Node builtins that must never reach the edge bundle.
 *
 * The panel bootstraps from the Node runtime only, but webpack still walks
 * server modules while compiling the edge (middleware) graph. Aliasing the
 * Node-only builtins to an empty module for `nextRuntime === 'edge'` keeps that
 * bundle clean — no reachable code path there uses them.
 */
const NODE_ONLY_BUILTINS = [
  'node:child_process',
  'node:cluster',
  'node:dgram',
  'node:dns',
  'node:events',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:https',
  'node:module',
  'node:net',
  'node:os',
  'node:path',
  'node:readline',
  'node:stream',
  'node:tls',
  'node:tty',
  'node:url',
  'node:util',
  'node:v8',
  'node:worker_threads',
  'node:zlib',
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
  webpack(config, { nextRuntime }) {
    if (nextRuntime === 'edge') {
      const alias = config.resolve.alias ?? {};
      for (const builtin of NODE_ONLY_BUILTINS) {
        alias[builtin] = false;
      }
      config.resolve.alias = alias;
    }
    return config;
  },
};

export default nextConfig;
