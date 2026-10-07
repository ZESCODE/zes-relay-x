# syntax=docker/dockerfile:1
#
# Build context: the **repository root** (the image needs pol_relay.py next to
# the panel). The compose file in this directory already sets that up:
#
#   docker build -f control-panel/Dockerfile -t zes-relay-panel .
#
# ── 1. dependencies ─────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY control-panel/package.json control-panel/package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── 2. build ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY control-panel/ ./
# The panel never phones home: telemetry stays disabled at build and runtime.
RUN npm run build

# ── 3. runtime ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
# python3 runs pol_relay.py; tini reaps zombies and forwards SIGTERM so the
# panel can shut the relay down gracefully.
RUN apk add --no-cache python3 ca-certificates tini
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PANEL_HOST=0.0.0.0 \
    PANEL_ALLOW_PUBLIC=true \
    PANEL_DATA_DIR=/app/data \
    PANEL_RELAY_SCRIPT=/app/pol_relay.py \
    PANEL_PYTHON_BIN=python3

COPY control-panel/package.json control-panel/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/tailwind.config.ts ./tailwind.config.ts
COPY control-panel/scripts ./scripts
COPY pol_relay.py ./pol_relay.py

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000 7179
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "scripts/start.mjs"]
