# ZES Relay Control Panel

A **Frost-styled mission control** for [`pol_relay.py`](./pol_relay.py) — the small
OpenAI-compatible HTTP relay that proxies `POST /v1/chat/completions` and
`GET /v1/models` to an upstream such as `https://gen.pollinations.ai/v1`.

The panel spawns and supervises the relay, measures every request that flows
through it, tails the process output, edits the relay's `.env`, streams chat
completions from the browser, and gives you tokens, backups and audit logs —
all from one glass-morphic Next.js app that binds to loopback by default.

```
 ┌──────────────────────────┐        ┌──────────────────────────┐        ┌──────────────────────────┐
 │  Browser (frost UI)      │  HTTP  │  Next.js control panel   │  HTTP  │  pol_relay.py            │
 │  dashboard · playground  │ ─────► │  /api/*  (node runtime)  │ ─────► │  127.0.0.1:7179          │
 │  logs      · config      │ ◄───── │  SSE metrics + log tail  │ ◄───── │  [pol-relay] stderr      │
 │  admin                   │        │  spawn · health · env    │  spawn │                          │
 └──────────────────────────┘        └──────────────────────────┘        └────────────┬─────────────┘
                                                  ▲                                  │ HTTPS
                                                  │ reads/writes                     ▼
                                          ┌──────────────────────────┐      ┌──────────────────────────┐
                                          │  <repo>/data/  (0700)    │      │  Upstream OpenAI-compat. │
                                          │  .env · panel.json       │      │  gen.pollinations.ai/v1  │
                                          │  metrics.json · logs/    │      └──────────────────────────┘
                                          │  events.jsonl · backups/ │
                                          └──────────────────────────┘
```

---

## Table of contents

- [Highlights](#highlights)
- [Screens](#screens)
- [Quick start](#quick-start)
- [How to run](#how-to-run)
- [Relay contract](#relay-contract)
- [Panel API](#panel-api)
- [Environment variables](#environment-variables)
- [Security model](#security-model)
- [Data directory](#data-directory)
- [Operations runbook](#operations-runbook)
- [Testing](#testing)
- [Docker](#docker)
- [Project layout](#project-layout)
- [Design notes — Frost](#design-notes--frost)
- [Troubleshooting](#troubleshooting)

---

## Highlights

| Area | What you get |
| --- | --- |
| **Relay lifecycle** | One-click start / stop / restart, singleton process registry on `globalThis`, adoption of an already-running relay, 5 s health probes, `SIGTERM → 5 s → SIGKILL`, auto-restart with 1 s / 2 s / 4 s backoff, and a guarded “force kill external process” path that requires two confirmations. |
| **Metrics** | Ring buffers (3600 samples / 1440 minute buckets), counters for requests, streams, bytes in/out, tokens in/out, errors by status, p50/p95/p99 latency, per-model and per-endpoint breakdowns, plus a 2 s SSE feed. |
| **Playground** | Live model dropdown, message editor with reorder/delete, temperature / top_p / penalties / seed / stop sequences, real token-by-token streaming through a hand-rolled SSE parser (`fetch` + `ReadableStream`, never `EventSource`), TTFB + total latency, usage totals, presets, and raw request/response panes. |
| **Logs** | Merged panel + relay streams, SSE tail with backlog, level / source / substring / regex filters, `[pol-relay]` highlighting, freeze + auto-scroll, windowed rendering for 5 000-row buffers, and `.log` / `.jsonl` download. |
| **Config** | Editor for `data/.env` (`POL_RELAY_PORT`, `POL_UPSTREAM_BASE`, `POL_API_KEY`, `POL_SKIP_AUTH`), masked secret with an audited reveal endpoint, validation + diff against the values the running relay actually received, **Save & restart**. |
| **Auth** | scrypt password hashing, signed httpOnly `SameSite=Lax` (Secure in production) session cookies, Bearer API tokens with scopes, double-submit CSRF + Origin checks, login throttling (5/min/IP), strict CSP, and a first-run admin that is either taken from the environment or generated and printed once. |
| **Admin** | Token CRUD with last-used timestamps, settings export/import (secrets excluded by default), buffer reset, zip backups of `data/`, and a system card with panel / Node / Python versions plus the SHA-256 of the running relay script. |
| **UX** | Frost glass design system (dark by default, light toggle persisted in a cookie), responsive layout, 2 s live refresh that pauses when the tab is hidden, toast notifications, keyboard shortcuts (`g d`, `g p`, `g l`, `g c`, `g a`, `?`), and accessible dialogs/tables/live regions. |

> The panel never modifies the relay's wire protocol. It is a *client* of the
> relay — everything the relay sees on the wire is stock OpenAI-compatible HTTP.

---

## Screens

The UI is composed of five consoles; each one is described below so the layout
is legible without a screenshot. (Add PNGs to `control-panel/public/screens/`
and link them here if you want them committed — the panel itself bundles none,
so the build stays binary-free.)

### Dashboard — `/dashboard`

```
┌ Relay control ────────────────────────────────────────────┐  ┌ ⇄ Requests (all sources) ──┐
│ Running · healthy · managed          [▶ Start] [■ Stop]   │  │ 75   54/min · 0.8/s   ↓ chg │
│ Endpoint  http://127.0.0.1:7179      [⟳ Restart] [Probe]  │  │ ▁▂▅▇▅▃▂ (sparkline)        │
│ PID 4451 · Uptime 1m 24s · probe 5 ms                     │  └────────────────────────────┘
│ Upstream https://gen.pollinations.ai/v1 · auth: forward   │  ┌ ✎ Tokens ──┐ ┌ ⏱ p95 ────┐
│ Script  /app/pol_relay.py · bdc774d4…                     │  │ 1.4K       │ │ 1.45 s    │
└───────────────────────────────────────────────────────────┘  └────────────┘ └───────────┘
┌ Traffic · 15m │ 1h │ 6h │ 24h ────────────────────────────┐  ┌ Models ─────────────────────┐
│ ▁▃▅▂▇▅▃▂  requests (+ errors overlay)                     │  │ demo-mistral 6  176/439 tok │
│ ╱╲╱╲╱╲╱╲  p50 / p95 / p99 latency lines                 │  │ demo-openai  6  124/270 tok │
└───────────────────────────────────────────────────────────┘  └─────────────────────────────┘
┌ Recent errors ────────────────────────────────────────────┐  ┌ Lifecycle events ───────────┐
│ 422 /api/chat · validation_failed · just now              │  │ spawned · health_up · …     │
└───────────────────────────────────────────────────────────┘  └─────────────────────────────┘
```

### Playground — `/playground`

```
┌ Parameters ───────────┐ ┌ Conversation ─────────────────────────────────┐ ┌ Presets & usage ─┐
│ Model [demo-openai ▾] │ │ system   You are a terse assistant.           │ │ save / load / ✕  │
│ ●──────────────── 0.7 │ │ user     Explain SSE vs WebSocket in 2 lines. │ │ TTFB 112 ms      │
│ ●────────── 1.0 top_p │ │ assistant ▍ (streaming token by token)        │ │ Total 1.19 s     │
│ ☑ stream              │ │                                               │ │ 92 tokens        │
│ [▶ Send] [■ Cancel]   │ │ [composer]                        [Reorder ↑↓] │ │ raw request/…    │
└───────────────────────┘ └───────────────────────────────────────────────┘ └──────────────────┘
```

### Logs — `/logs`  ·  **Config** — `/config`  ·  **Admin** — `/admin`

Logs renders a virtualised console with a filter bar and a detail pane; Config
renders the four relay keys with validation, diff and Save & restart; Admin
renders token CRUD, backups, buffer reset and the system card.

---

## Quick start

```bash
git clone https://github.com/ZESCODE/zes-relay-x.git
cd zes-relay-x/control-panel
npm install
cp .env.example .env.local        # optional — every value has a default
PANEL_ADMIN_PASSWORD='change-me-now' npm run dev
# open http://127.0.0.1:3000  → sign in → Dashboard → Start relay
```

The relay binary itself needs nothing but **Python 3.8+** (standard library
only, no `pip install`).

---

## How to run

Everything below runs from `zes-relay-x/control-panel/`.

```bash
# 1 ─ install (Node 18.18+)
npm install

# 2 ─ configure (all optional; defaults shown in .env.example)
cp .env.example .env.local
#   PANEL_HOST=127.0.0.1      bind loopback unless PANEL_ALLOW_PUBLIC=true
#   PANEL_PORT=3000
#   PANEL_ADMIN_PASSWORD=…    omit to get a one-time password in the log
#   POL_UPSTREAM_BASE=https://gen.pollinations.ai/v1
#   POL_SKIP_AUTH=true

# 3 ─ development server (host/port guarded wrapper around `next dev`)
npm run dev

# 4 ─ production
npm run build && npm start

# 5 ─ gates
npm run typecheck     # tsc --noEmit
npm run lint          # next lint
npm test              # vitest run  (unit + relay integration)

# 6 ─ offline demo (no external network): mock upstream + real relay
node tools/demo-upstream.mjs --port 7189 --delay 25 &   # OpenAI-compatible mock
POL_UPSTREAM_BASE=http://127.0.0.1:7189/v1 POL_SKIP_AUTH=true npm run dev
node tools/seed-traffic.mjs --user admin --password "$PANEL_ADMIN_PASSWORD" --count 12

# 7 ─ the relay on its own (no panel)
python3 ../pol_relay.py --port 7179          # or: POL_RELAY_PORT=7179 python3 ../pol_relay.py
curl -s localhost:7179/v1/models
curl -s localhost:7179/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"openai","messages":[{"role":"user","content":"ping"}]}'

# 8 ─ Docker
docker compose up --build          # panel on 127.0.0.1:3000, data in a named volume

# 9 ─ assemble a single-file copy of the sources (BUILD-PROMPT output format)
npm run bundle                      # → control-panel/DELIVERABLE.md
```

With no `PANEL_ADMIN_PASSWORD` set, the first run mints a one-time admin
password and prints it **exactly once** — to the terminal and to
`data/logs/panel.jsonl`:

```
[pol-relay] panel: Created the panel admin account "admin".
[pol-relay] panel: ════════ ONE-TIME ADMIN PASSWORD ════════
[pol-relay] panel:   username: admin
[pol-relay] panel:   password: 7Fq2mS9pLxR4tVbWkZ3n
[pol-relay] panel:   Shown once — change it in Admin → Account right after signing in.
[pol-relay] panel: ══════════════════════════════════════════
```

Sign in with that password, then change it under **Admin → Account** (the panel
flags `mustChangePassword` until you do).

---

## Relay contract

`pol_relay.py` is intentionally tiny and dependency-free. The panel treats it
as an opaque OpenAI-compatible upstream; nothing in the panel changes its wire
format.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/models` | Proxied verbatim (JSON). |
| `POST` | `/v1/chat/completions` | JSON in, JSON or `text/event-stream` out. Streaming bodies are relayed chunk-by-chunk (chunked transfer encoding, no buffering). |
| `OPTIONS` | any | `204` + `Allow` for preflight. |
| *anything else* | — | `404` with an OpenAI-shaped error body. |

Behaviour:

- Binds `127.0.0.1:${POL_RELAY_PORT:-7179}` (`POL_RELAY_HOST` to override).
- Injects `Authorization: Bearer ${POL_API_KEY}` unless `POL_SKIP_AUTH=true`, in
  which case the caller's `Authorization` header is forwarded when present.
- Streams with a 1 KiB read loop; aborted clients log
  `client disconnected mid-stream` and the upstream socket is closed.
- Every request writes one parseable access line to stderr:

  ```
  [pol-relay] 2026-10-07T15:52:12Z POST /v1/chat/completions 200 model=openai 385ms stream=true rid=<id>
  ```

  The panel's log parser turns those lines into metrics — which means traffic
  that bypasses the panel entirely still shows up on the dashboard.

---

## Panel API

All endpoints answer with the same envelope and are `runtime = 'nodejs'`,
`dynamic = 'force-dynamic'`:

```json
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "validation_failed", "message": "…", "details": {} } }
```

Error codes: `bad_request` (400), `unauthorized` (401), `forbidden` (403),
`not_found` (404), `conflict` (409), `validation_failed` (422),
`rate_limited` (429), `upstream_unavailable` (502), `relay_unavailable` (503),
`internal_error` (500).

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/health` | `GET` | Liveness probe (unauthenticated, leaks nothing). |
| `/api/auth/login` | `POST` | Username + password → session cookie + CSRF cookie. |
| `/api/auth/logout` | `POST` | Clears the session. |
| `/api/auth/me` | `GET` | Current user, auth mode, CSRF token, theme. |
| `/api/auth/password` | `POST` | Change the password (needs the current one). |
| `/api/theme` | `POST` | Persist `dark` / `light` in a cookie for the SSR layout. |
| `/api/relay/status` | `GET` | State, pid, uptime, config, lifecycle events. |
| `/api/relay/start` | `POST` | Idempotent: `alreadyRunning: true` when it is already up. |
| `/api/relay/stop` | `POST` | `{ "force": true, "confirmToken": "force-kill-external" }` for an unowned process. |
| `/api/relay/restart` | `POST` | Graceful restart of an owned relay. |
| `/api/relay/health` | `GET` | One synchronous probe of `GET /v1/models`. |
| `/api/metrics/summary` | `GET` | Counters, rates, latency percentiles, per-model/endpoint/status maps. |
| `/api/metrics/timeseries` | `GET` | `?range=15m\|1h\|6h\|24h` bucketed series. |
| `/api/metrics/models` | `GET` | Per-model metrics table. |
| `/api/metrics/errors` | `GET` | `?limit=` recent errors (≤ 500 chars each). |
| `/api/metrics/stream` | `GET` | SSE: `hello` then a `summary` frame every 2 s. |
| `/api/models` | `GET` | `?refresh=1` bypasses the 60 s model cache. |
| `/api/chat` | `POST` | Chat completion proxy — streams SSE straight through and records usage/latency. |
| `/api/chat/presets` | `GET` `POST` | List / create playground presets (`data/presets/<id>.json`). |
| `/api/chat/presets/[id]` | `GET` `DELETE` | Read / delete one preset. |
| `/api/logs` | `GET` | `?limit&cursor&level&source&q&regex&sinceMs` — newest first. |
| `/api/logs/stream` | `GET` | SSE tail: `hello` + backlog, then live `log` frames. |
| `/api/logs/download` | `GET` | `.log` or `.jsonl` export of the filtered buffer. |
| `/api/config` | `GET` `PUT` | Read `data/.env` / write values (`{ "restart": true }` to bounce the relay). |
| `/api/config/validate` | `POST` | Dry-run validation + optional live probe. |
| `/api/config/reveal` | `POST` | Audited read of `POL_API_KEY` (admin scope; every call is logged). |
| `/api/admin/tokens` | `GET` `POST` | List / mint API tokens (secret returned **once**). |
| `/api/admin/tokens/[id]` | `DELETE` | Revoke a token. |
| `/api/admin/backup` | `GET` `POST` | List / create zip backups of `data/`. |
| `/api/admin/backup/[id]` | `GET` | Download one archive. |
| `/api/admin/reset` | `POST` | Clear in-memory buffers (`metrics`, `logs`, `errors`, `events`, `presets`). |
| `/api/admin/system` | `GET` | Versions, data-dir size, memory, masked environment, relay script hash. |
| `/api/admin/export` | `GET` | Settings JSON (`?secrets=true` to include `POL_API_KEY`). |
| `/api/admin/import` | `POST` | Whitelisted settings import (`{ restart }` to bounce the relay). |

CLI equivalents:

```bash
curl -s -H "Authorization: Bearer $ZES_TOKEN" http://127.0.0.1:3000/api/metrics/summary | jq
curl -s -X POST http://127.0.0.1:3000/api/relay/restart -H "Authorization: Bearer $ZES_TOKEN" | jq
```

---

## Environment variables

Every knob has a default, so `.env.example` is a complete, copy-pasteable
reference. `PANEL_*` configures the panel, `POL_*` configures the relay (and can
also be edited at runtime from the **Config** page, which writes `data/.env`).

### Panel server

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_HOST` | `127.0.0.1` | Interface to bind. Non-loopback values are refused unless `PANEL_ALLOW_PUBLIC=true`. |
| `PANEL_PORT` | `3000` | Panel port (validated before the child process starts). |
| `PANEL_ALLOW_PUBLIC` | `false` | Opt-in for binding a public interface. |
| `PANEL_FRAME_ANCESTORS` | `'none'` | CSP `frame-ancestors`. Setting it (or `PANEL_EMBEDDABLE=true`) drops `X-Frame-Options` so a trusted proxy can embed the panel. |
| `PANEL_EMBEDDABLE` | `false` | Same as above, without a whitelist. |
| `PANEL_DATA_DIR` | `<repo>/data` | Absolute path for runtime state (falls back to `<cwd>/data`). Created `0700`. |
| `PANEL_SESSION_SECRET` | *generated* | HMAC secret for session JWTs. Empty ⇒ random 48-byte secret stored in `data/.session-secret` (`0600`). |
| `PANEL_SESSION_TTL_HOURS` | `12` | Session lifetime. |
| `PANEL_ADMIN_USER` | `admin` | First-run admin username. |
| `PANEL_ADMIN_PASSWORD` | *generated* | First-run admin password (≥ 10 chars). Empty ⇒ one-time password printed once. |
| `PANEL_TRUST_PROXY` | `false` | Honour `X-Forwarded-For` / `X-Forwarded-Host` (rate limiting + Origin checks). |
| `NEXT_TELEMETRY_DISABLED` | `1` | Keeps the build and runtime telemetry-free. |

### Relay process

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_RELAY_SCRIPT` | `../pol_relay.py` | Relay entry point (absolute or panel-relative). An explicit value is authoritative — a typo fails loudly instead of silently falling back. |
| `PANEL_RELAY_SCRIPT_FALLBACK` | `../pol-relay.sh` | Used only when `PANEL_RELAY_SCRIPT` is unset. |
| `PANEL_PYTHON_BIN` | `python3` | Interpreter used to spawn the relay. |
| `PANEL_RELAY_BEARER` | *unset* | Optional bearer token the panel sends to the relay (for `POL_SKIP_AUTH=true` deployments that still need a key upstream). |
| `POL_RELAY_PORT` | `7179` | Relay listen port (also editable in `data/.env`). |
| `POL_UPSTREAM_BASE` | `https://gen.pollinations.ai/v1` | Upstream OpenAI-compatible base URL. |
| `POL_API_KEY` | *unset* | Upstream key; injected as `Authorization: Bearer …` unless `POL_SKIP_AUTH=true`. |
| `POL_SKIP_AUTH` | `true` | Forward the caller's `Authorization` header instead of injecting the key. |
| `POL_RELAY_HOST` | `127.0.0.1` | Relay bind address (relay-side). |
| `POL_UPSTREAM_TIMEOUT` | `300` | Upstream socket timeout in seconds (relay-side). |
| `POL_MAX_BODY_BYTES` | `8388608` | Request body ceiling (relay-side). |
| `POL_DEBUG` | *unset* | Verbose relay HTTP logging. |

### Manager, limits and buffers

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_HEALTH_INTERVAL_MS` | `5000` | Health-probe cadence. |
| `PANEL_HEALTH_TIMEOUT_MS` | `2000` | Probe timeout. |
| `PANEL_AUTORESTART` | `3` | Restarts allowed in the backoff window (0 disables). |
| `PANEL_SHUTDOWN_GRACE_MS` | `5000` | Grace between `SIGTERM` and `SIGKILL`. |
| `PANEL_START_TIMEOUT_MS` | `8000` | How long a fresh relay may take to answer `/v1/models`. |
| `PANEL_RESTART_BACKOFF_MS` | `1000` | Base backoff; doubles per attempt (1 s → 2 s → 4 s). |
| `PANEL_LOGIN_RATE_LIMIT` | `5` | Login attempts per IP per window. |
| `PANEL_CHAT_RATE_LIMIT` | `60` | Chat completions per caller per window. |
| `PANEL_RATE_WINDOW_MS` | `60000` | Rate-limit window. |
| `PANEL_MAX_LOG_ENTRIES` | `5000` | Log ring-buffer capacity. |
| `PANEL_METRICS_SAMPLES` | `3600` | Sample ring capacity. |
| `PANEL_METRICS_BUCKETS` | `1440` | Minute-bucket ring capacity (24 h of series). |
| `PANEL_METRICS_TICK_MS` | `5000` | Metrics sample interval (ring buffers / sparklines). |
| `PANEL_METRICS_STREAM_MS` | `2000` | Cadence of the dashboard's SSE feed; the polling fallback runs at 5 s. |
| `PANEL_PANEL_LOG_MAX_BYTES` | `5242880` | `data/logs/panel.jsonl` rotation size (0 disables file logging). |
| `PANEL_PANEL_LOG_KEEP` | `3` | Rotated generations kept. |
| `PANEL_CHAT_MAX_BODY_BYTES` | `1048576` | `/api/chat` body ceiling. |
| `PANEL_REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout. |
| `PANEL_MAX_PRESETS` | `200` | Preset ceiling. |
| `PANEL_MAX_BACKUPS` | `50` | Backups kept before pruning. |
| `PANEL_MAX_ERRORS` | `100` | Error feed depth. |

`.env.local` (dev) and `.env` (container) are loaded by both Next and
`scripts/start.mjs`; real environment variables always win.

---

## Security model

| Threat | Mitigation |
| --- | --- |
| Someone reaching the panel over the network | Binds `127.0.0.1` and **refuses** to start on a public interface unless `PANEL_ALLOW_PUBLIC=true`; the refusal message explains the proxy/SSH-tunnel alternatives. |
| Credential theft from the DB | Passwords are scrypt (`N=16384, r=8, p=1`, 64-byte key, per-user salt) and compared with `crypto.timingSafeEqual`. |
| Session theft via XSS | Sessions live in an `httpOnly` cookie (never `localStorage`), `SameSite=Lax`, `Secure` in production. Strict CSP with a per-request nonce; no inline event handlers; `object-src 'none'`. |
| CSRF | Origin/Host check **and** double-submit: the `zes_csrf` cookie must equal the `x-csrf-token` header on every mutation (except login, which has no ambient session yet). |
| Brute force | Login limited to 5 attempts/min/IP in the edge middleware *and* again in the Node rate limiter; the successful login resets the budget. |
| Token leakage | API tokens are shown once; only a SHA-256 hash plus an 8-character prefix is stored. Scopes (`read` / `write` / `admin`) are enforced per route; token auth can never mint tokens. |
| Killing the wrong process | The panel only signals a relay it spawned. Ending an external process requires `force: true` **and** the confirmation token `force-kill-external`, surfaced in the UI behind two dialogs. |
| Secrets in logs/backups | `Bearer …`, `api_key=…`, `POL_API_KEY=…` are redacted before anything is buffered or written; backups redact `POL_API_KEY` and the password hash unless you explicitly opt in; the session secret is never included. |
| Secrets in the browser | `GET /api/config` returns `masked: true` for `POL_API_KEY`; reading it requires the admin-scoped `POST /api/config/reveal`, which writes an audit line. |
| Telemetry / phone-home | None. No analytics, no external fonts or CDNs, `NEXT_TELEMETRY_DISABLED=1` in `.env.example`, and the only outbound calls are the ones the relay makes to your configured upstream. |

---

## Data directory

Created on first run with mode `0700` (files `0600` where they hold secrets):

```
data/
├─ .env                # relay configuration edited by the Config page
├─ .session-secret     # generated HMAC secret for session JWTs (0600)
├─ panel.json          # users, password hashes, panel settings (0600)
├─ tokens.json         # API tokens: hash + prefix + scopes + last used
├─ metrics.json        # persisted counters (restored on restart)
├─ events.jsonl        # lifecycle events (append-only)
├─ logs/
│  └─ panel.jsonl      # structured log records, size-rotated (×3)
├─ presets/
│  └─ <id>.json        # playground presets
└─ backups/
   └─ 2026-10-07T15-52-13-000Z-a1b2c3.zip
```

Everything is plain JSON / JSONL on purpose: it survives `git`, `zip`, `jq`,
and a text editor. Retention is bounded by the settings above; `Admin → Data`
clears the in-memory buffers without touching the files on disk.

---

## Operations runbook

**Start / stop without the UI**

```bash
curl -s -X POST localhost:3000/api/relay/start   -H "Authorization: Bearer $ZES_TOKEN" | jq .data.state
curl -s -X POST localhost:3000/api/relay/stop    -H "Authorization: Bearer $ZES_TOKEN" | jq .data.state
curl -s -X POST localhost:3000/api/relay/restart -H "Authorization: Bearer $ZES_TOKEN" | jq .data.state
```

**Adopting a relay you started by hand** — the panel probes the port at boot and
during every health tick; a healthy OpenAI-compatible relay is adopted
(`owned: false`) and never killed. `Admin → Overview` shows
`externalProcess.detected` when the port is held by something that is *not* a
relay; `Stop → Force kill external process` is then available behind two
confirmations.

**Rotating the upstream key**

1. `Config` → paste the new `POL_API_KEY` → **Validate** (dry run, no writes).
2. **Save & restart** — the panel writes `data/.env` and bounces the relay.
3. `Dashboard` shows `Auth mode` and the probe result; a failed probe raises the
   red banner until it clears.

**Backups**

```bash
curl -s -X POST localhost:3000/api/admin/backup -H "Authorization: Bearer $ZES_TOKEN" | jq .data.backup
# { "id": "2026-10-07T15-52-13-000Z-a1b2c3", "bytes": 20480, "files": 9, "containsSecrets": false }
```

**When the relay is down** the panel keeps working: metrics keep their last
values, the log tail keeps flowing, and a persistent banner explains whether the
failure is “relay not answering”, “port in use by another process”, or “script
missing”.

---

## Testing

```bash
npm run typecheck     # strict TS, noUncheckedIndexedAccess
npm run lint          # next lint (0 warnings)
npm test              # vitest run — 41 tests across 4 files
npm run test:integration
```

| File | Covers |
| --- | --- |
| `tests/auth.test.ts` | scrypt hashing + verification, JWT sessions (tamper/expiry/secret mismatch), first-run admin, password rotation, redaction. |
| `tests/metrics.test.ts` | Ring buffers, percentiles, counters, per-model maps, timeseries bucketing, rates, persistence, log parsing and log-bus filtering. |
| `tests/relay-manager.test.ts` | Spawn → healthy → graceful stop, idempotent start, adoption of an external relay, refusal to kill it without the token, port conflicts, missing script, relay-stderr → metrics pipeline. |
| `tests/relay-integration.test.ts` | **The real `pol_relay.py`** on a temp port against a local OpenAI-compatible mock: `/v1/models`, non-streaming completion with usage, incremental SSE (first chunk < 3 s), error envelope, script hash. |

The integration test runs `python3 ../pol_relay.py` with
`POL_UPSTREAM_BASE=http://127.0.0.1:<mock>/v1`, so it needs **no network at all**.

---

## Docker

```bash
cd control-panel
PANEL_ADMIN_PASSWORD='choose-something' docker compose up --build
# → panel on http://127.0.0.1:3000  (data in the named volume zes-relay-panel-data)
```

The image is a three-stage build (`node:20-alpine` + `python3` + `tini`) that
builds the panel, ships `pol_relay.py`, runs as the unprivileged `node` user,
exposes `/app/data` as a volume, and wires `/api/health` into `HEALTHCHECK`.
`tini` is PID 1 so `docker compose stop` reaches the panel, which then stops an
owned relay gracefully. Note the build context is the **repository root** (the
image needs `pol_relay.py` next to the panel).

---

## Project layout

```
zes-relay-x/
├─ pol_relay.py               # the relay (stdlib-only Python 3)
├─ pol-relay.sh               # legacy launcher kept for compatibility
├─ BUILD-PROMPT.md            # the specification this panel was built against
└─ control-panel/
   ├─ src/middleware.ts       # edge gate: CSP nonce, auth redirect, CSRF, login throttle
   ├─ next.config.mjs         # security headers, framing policy, edge-safe builtins
   ├─ tailwind.config.ts      # Frost design tokens
   ├─ scripts/start.mjs       # host/port guard + .env loader around next dev|start
   ├─ tools/                  # demo upstream, traffic seeder, source bundler
   ├─ tests/                  # vitest suites + fixtures
   └─ src/
      ├─ app/                 # App Router pages + 30 route handlers
      ├─ components/          # ui kit, charts, dashboard, chat, logs, config, layout
      ├─ lib/                 # types, api client, SSE parser, formatting, hooks
      └─ server/              # relay manager, metrics, logs, auth, config, backups
```

---

## Design notes — Frost

Ported from [`ZESCODE/frost-cards`](https://github.com/ZESCODE/frost-cards):

- **Glass surfaces** — `rgba(255,255,255,0.07)` with 16–22 px backdrop blur, a
  hairline border, an inset top highlight, and a soft drop shadow.
- **Four frost accents** — emerald `#22c55e → #10b981`, blue `#3b82f6 →
  #2563eb`, orange `#f97316 → #ea580c`, red `#ef4444 → #dc2626`. Each frost card
  carries a colour-matched `box-shadow` glow that intensifies on hover.
- **Dark first, light second** — the dark palette is the default; the light
  theme is an “ice sheet” variant that remaps the alpha scale so a single class
  list works in both themes. The choice is stored in a cookie and applied during
  SSR, so there is no flash.
- **Motion** — fade/slide entrances, a pulsing live dot, a streaming caret, and
  160–220 ms transitions; everything respects `prefers-reduced-motion` through
  the Tailwind defaults.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Refusing to bind 0.0.0.0:3000` | Deliberate. Use `PANEL_ALLOW_PUBLIC=true` (plus a proxy and `PANEL_SESSION_SECRET`) or keep loopback and `ssh -L 3000:127.0.0.1:3000 user@host`. |
| Red banner: “Relay unreachable” | The relay is not running, the port is taken, or the script is missing. `Dashboard → Relay control` prints the exact reason; `Admin → Overview` shows what holds the port. |
| `[panel] relay script not found` | `PANEL_RELAY_SCRIPT` points at a file that does not exist. An explicit path is never silently replaced by a fallback. |
| `already in use by another process` | Something that is not a relay owns the port: stop it, change `POL_RELAY_PORT`, or use the double-confirmed force kill. |
| Login returns `429` | Five attempts per minute per IP. Wait a minute (the middleware budget resets with it). |
| `CSRF token missing or mismatched` | The browser blocked the `zes_csrf` cookie or the session is for a different origin. Reload the page; over plain HTTP behind a proxy keep `PANEL_TRUST_PROXY=true`. |
| Chat shows `relay_unavailable` | The relay process is not answering. Check `Dashboard → Last probe` and `Logs → relay`. |
| Tokens stay at zero | Usage is only counted when the upstream returns a `usage` object (the playground shows the raw frames so you can confirm). |
| Panel is reachable but `/api/*` returns `401` | Sessions are per-origin and `httpOnly`; sign in again and remember that API scripts should use a Bearer token. |
| `Could not find a production build in the '.next' directory` | `next dev` replaces the production build. Run `npm run build` again before `npm start`. |
| Banners/probing look one step behind | The dashboard subscribes to `/api/metrics/stream` (2 s). If SSE is blocked by a proxy, it falls back to 5 s polling — the header chip tells you which mode is active. |

---

Built against [`BUILD-PROMPT.md`](./BUILD-PROMPT.md). Relay logging format,
envelope shape and the Frost token set are part of the contract — change them
together or not at all.
