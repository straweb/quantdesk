# Multi-Broker Trading Terminal

A self-hosted, multi-broker options/futures trading terminal built for Indian markets (NSE / BSE / MCX / CDS). One web UI drives **simulated and live broker accounts** — orders fan out to every enabled account with per-account capital sizing ("house rules"), realtime market feed, an in-house Canvas charting engine (no TradingView), a strike-panel options desk, an auto-bot rule engine, a Python strategy runtime, and paper-trading tick replay.

Supported brokers / feeds:

| Source | Kind | Orders | Live APIs |
|---|---|---|---|
| **Sim Feed** (built-in) | simulated ticks + fills | yes (sandbox fills) | — |
| **Dhan** (API v2) | live broker | yes | place/modify/cancel, order/trade book, positions, funds, holdings, margin calc, quote |
| **Shoonya** (Noren) | live broker | yes | place/modify/cancel, order/trade/position book, limits, quote, holdings, margin |
| **ICICI Breeze** | live broker | yes | place/modify/cancel, order book, trades, positions, margins, quotes, holdings |

> ⚠️ **Trading risk notice** — this software places real orders when live broker accounts are connected and order-routing is enabled. Test with the Sim Feed accounts first. The authors accept no liability for trading losses.

---

## 1. Tech stack & architecture

- **Frontend**: Next.js 16 (App Router, React 19, TypeScript, Tailwind 4, shadcn/ui, zustand, socket.io-client). Single-page terminal SPA under `/`.
- **Backend**: Next.js API routes (Node runtime) + service modules in `src/lib/services/` + a broker plugin layer in `brokers/` (OpenAlgo-style adapters, one SQLite DB per broker account).
- **Market feed mini-service**: `mini-services/market-feed` (Bun + socket.io) — tick engine, candle aggregation (1m→1d), tick recorder, replay engine, and the realtime **sync hub** that replaces REST polling.
- **Python runner**: strategies run as `python3` subprocesses with an injected SDK (`get_candles`, `get_quote`, `log`, `signal`), talking to the feed REST API.
- **Gateway**: Caddy on **:81** → Next.js on **:3000**; socket.io reached through the same gateway via `?XTransformPort=3003`.

```
Browser ──► Caddy :81 ──┬─► Next.js :3000  (SPA + /api/* + schedulers)
                        └─► /?XTransformPort=N → any localhost port
                                └─► market-feed :3003 (socket.io: ticks + sync)
                                    market-feed :3004 (REST: candles/quote/replay/health)

Next.js instrumentation (boot):
  • bootstrap master DB + admin user + demo accounts
  • master-contracts symbol sync → feed universe publish (850+ symbols)
  • strategy scheduler (1s), auto-bot rules engine (250ms), GTT engine (1s),
    resting-order monitor (1s), live fill reconciliation (5s, live accounts)
  • mutual watchdog: respawns the feed service if :3004 goes dark (and vice versa)
```

### Data layout

| Store | Location | Contents |
|---|---|---|
| Master DB (Prisma) | `db/custom.db` (`DATABASE_URL`) | admin user, broker accounts, capital configs, symbol master + broker mappings, copy-trade configs, strategies/logs, sync logs, order audit |
| Per-broker DBs | `db/brokers/{brokerType}/{accountId}.db` | orders, trades, positions, funds ledger per account |
| Tick sessions | `db/ticks/<IST-date>/session-<HHMMSS>.db` | recorded tick streams (replay data source) |
| JSON stores | `db/auto-rules.json`, `db/gtt.json`, `db/feed-source.json`, `db/ticks/tick-recorder.json` | auto-bot rules, GTT orders, active feed source, recorder config |
| Python exports | `strategies/*.py` | exported strategy code |

---

## 2. Ports (all environments)

| Port | Service | Exposed? | Notes |
|---|---|---|---|
| **:81** | **Caddy gateway — the only public port in production** | yes | proxies `/*` → `localhost:3000`; `/?XTransformPort=N` proxies to any localhost port (browser socket.io uses `?XTransformPort=3003`) |
| **:3000** | Next.js terminal (UI + REST API) | internal (behind Caddy) | direct access works but socket.io has no proxy path there → FEED chip shows DOWN |
| **:3003** | market-feed **socket.io** (ticks + sync hub) | internal | browser reaches it through Caddy `?XTransformPort=3003` |
| **:3004** | market-feed **REST** (`/health`, `/candles`, `/quote`, `/depth`, `/ltp`, `/feed-source`, `/feed-status`, `/replay-*`, `/tick-*`, `/universe`) | internal | consumed server-side by Next.js and the Python runner |

In the production environment **only :81 needs to be reachable** (firewall/SG: open 81, keep 3000/3003/3004 bound to localhost).

---

## 3. Environment settings

Copy `.env.example` → `.env` and adjust. Full list with explanations lives there; summary:

| Variable | Default | Used by | Notes |
|---|---|---|---|
| `DATABASE_URL` | `file:/home/z/my-project/db/custom.db` | Next.js (Prisma) | SQLite path for the master DB |
| `TERMINAL_SECRET` | `zterm-default-secret-change-in-prod` | crypto layer | **Set a strong random value in production** (`openssl rand -hex 32`). Derives the AES-256-GCM key encrypting broker credentials at rest + HMAC session cookies. Changing it invalidates sessions and saved broker credentials. |
| `PORT` | `3000` (Next) / `3003` (feed) | both | Pinned by npm scripts / watchdog; set only when launching processes manually |
| `REST_PORT` | `3004` | feed service | REST port of the mini-service |
| `FEED_SERVICE_URL` | `http://localhost:3004` | Next.js API routes + watchdog | Server-side feed REST base URL |
| `FEED_REST_URL` | `http://localhost:3004` | Python runner, replay | Same endpoint family |
| `AUTO_DEBUG` | `0` | auto-bot/GTT engines | `1` = verbose fire-decision logs |
| `NODE_ENV` | dev/`production` | Next.js | Set by scripts |

Broker API keys/secrets are **not** env vars — they are entered in **Admin → Accounts** (each input shows a sample value; an **Edit** dialog can modify user id / client id / api key / secret at any time, stored values masked, empty = unchanged), encrypted with `TERMINAL_SECRET`, and live sessions are established per account in **Admin → Accounts → Session**:

- **ICICI Breeze** — open the apiuser login URL → redirect `?apisession=` → paste it. The terminal exchanges it at `customerdetails` exactly like the Breeze SDK (GET with a raw JSON body `{SessionToken, AppKey}`).
- **Dhan** — paste **`PIN:TOTP`** (e.g. `123456:987654`) for direct token generation (`auth.dhan.co/app/generateAccessToken?dhanClientId=…&pin=…&totp=…`), or run the partner consent flow (partner_id/secret headers → `consent-login?consentId=` → paste the redirect `tokenId`), or paste a direct JWT from web.dhan.co.
- **Shoonya** — official OAuth URL `https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id={client_id}` → redirect `?code=` → paste it; GenAcsTok checksum variants (`{code, checksum}` on NorenWClientAPI, full jData verifiers on NorenWClientTP) are tried automatically and every attempt is logged. QuickAuth alternative: paste `pwd:factor2(:totp)`.

**Debugging a failing broker** — Admin → **Broker Diagnostics**: a timed 4-step test (credentials → mode → funds ₹ → quote LTP) plus the raw per-account call log. Every outbound broker call is tagged `[BROKER][tag] METHOD url → status (ms)` on the console and mirrored to the account's `broker_logs`.

**Live market data from brokers** — when a live account is the active feed source, the market-feed service polls that broker's quote APIs every second (Dhan batched quotes / Shoonya GetQuote / Breeze quotes), maps symbols via the master contracts, and streams real ticks into charts/panels (fed symbols skip the sim random walk). The FEED chip shows a live data dot (green ticking / amber stalled) plus the exact stall reason (missing session, broker error) from `/api/feed/status`.

**Capital from real funds** — for live brokers, leave Initial Capital blank when adding the account and it starts at **100 % of the broker's available cash**; the cash base auto-refreshes from the funds API every 45 s, can be pulled on demand (wallet icon in the FEED dropdown / “Pull funds” in a capital chip), and the % / fixed split is editable at any time — even while connected — from the FEED dropdown's cap chip.

---

## 4. How to run

### Prerequisites

- **Node.js ≥ 24** (Next.js), **Bun ≥ 1.3** (mini-service + prod server runner), **Python 3.12** (strategy runner), **Caddy** (gateway). On this machine all are preinstalled.
- No external DB server — everything is SQLite file-based.

### One-command scripts (recommended)

**`start.sh`** does the full lifecycle — creates `.env` if missing, installs deps, pushes the DB schema, builds, starts the terminal + feed, and waits for health:

```bash
./start.sh                # install + prisma setup + next build + run everything
./start.sh --skip-build   # start from the last build (no rebuild)
./start.sh --dev          # dev mode (next dev) instead of a production build
./stop.sh                 # stop terminal (:3000) + feed (:3003/:3004)
```

npm equivalents: `npm run start:sh` / `npm run stop`. Logs land in `logs/terminal.log` and `logs/feed.log` (PID files in `logs/*.pid`). On startup the script prints `READY — open http://localhost:3000` once `/api/auth/me` answers; login `admin` / `admin123`.

Production note: `./start.sh` binds the terminal to :3000 — keep Caddy running (`caddy run --config Caddyfile`) so users reach it on **:81**, the only public port.

### Install & boot (manual, first time)

```bash
npm install               # postinstall auto-runs `prisma generate`
npm run setup             # prisma generate + prisma db push (creates db/custom.db)
cp .env.example .env      # then edit TERMINAL_SECRET etc.
```

### Development

```bash
npm run dev               # Next.js dev server on :3000 (telemetry in dev.log)
```

The feed mini-service does **not** need manual startup — the Next.js instrumentation watchdog boots/respawns it (`bun --hot index.ts` with `PORT=3003 REST_PORT=3004`) within ~10s and republishes the 850-symbol universe. To run it manually:

```bash
cd mini-services/market-feed && PORT=3003 REST_PORT=3004 bun --hot index.ts
```

Then open **http://localhost:81** (Caddy) — or http://localhost:3000 for UI-only work (feed chip will show DOWN on :3000; use :81 for the full experience).

**First login**: `admin` / `admin123` — seeded automatically on first boot together with 6 demo accounts (3 Sim Feed, 3 broker sandboxes). *Change the password for production* (Admin view).

### Production

```bash
./start.sh                # build + run (recommended)
# or manually:
npm run build             # next build → standalone output (.next/standalone)
npm run start             # NODE_ENV=production bun .next/standalone/server.js
```

- The standalone server reads `PORT` (default 3000). Keep Caddy running (`caddy run --config Caddyfile`) so users hit **:81**.
- Run under a process supervisor (systemd unit, `pm2`, or `tmux`) — or just use `./start.sh` / `./stop.sh`, which manage PIDs for both processes. The two processes also self-heal each other (watchdogs).
- Logs: `logs/terminal.log` + `logs/feed.log` (start.sh), or `dev.log` (dev) / `server.log` (prod) via the npm scripts' `tee`.

### Troubleshooting

| Symptom | Cause & fix |
|---|---|
| **"Login temporarily unavailable — try again"** | The login API could not reach the database. Since v0.3 the terminal **self-heals** missing schema (runs `prisma generate` + `db push` automatically). If you still see it: run `npm run setup`, confirm `.env` exists (or delete it so the default `db/custom.db` path is used), then retry. The exact reason is printed in the server log. |
| `@prisma/client did not initialize yet` | Prisma client not generated — run `npm run setup` (or `npm install`, postinstall generates it). |
| Login says *Invalid credentials* but admin/admin123 is correct | Fresh DB seeded a new admin on first boot — the first login attempt ran during seeding. Retry once. |
| FEED chip DOWN on :3000 | Expected — socket.io has no proxy path on :3000; use the Caddy :81 entry. |
| Charts frozen after restarting only the feed | The Next.js watchdog republishes the 850-symbol universe within ~10s; wait or restart the terminal. |

### Verifying the deployment

```bash
curl -s localhost:3000/api/auth/me          # → {"user":null} (unauthenticated but alive)
curl -s localhost:3004/health | jq .symbols # universe size (>400 after boot sync)
curl -s "localhost:81/?XTransformPort=3003" # Caddy transform path responds (socket.io handshake)
```

### Maintenance commands

```bash
npm run setup        # prisma generate + db push (first-run / schema changes)
bun run db:push      # re-sync Prisma schema (dev)
bun run db:generate  # regenerate Prisma client after schema edits
bun run lint         # eslint
bun test             # unit tests (charges / crypto / capital / strikes)
bash tests/e2e/api-smoke.sh   # E2E API smoke test against a running server (:3000 + :3004)
```

---

## 5. Project structure

```
├── start.sh / stop.sh        # one-command build+run / stop (terminal + feed, PID-managed)
├── Caddyfile                  # :81 gateway config (incl. ?XTransformPort transform)
├── .env.example               # all environment settings, documented
├── prisma/schema.prisma       # master DB schema (accounts, symbols, strategies, audit…)
├── brokers/                   # broker plugin layer (OpenAlgo style)
│   ├── index.ts / registry.ts #   adapter registry + shared types
│   ├── execution.ts           #   shared sandbox fill engine → per-broker SQLite
│   ├── auth.ts                #   OAuth-style session flows (Breeze / Dhan / Shoonya)
│   ├── live-api.ts            #   live REST helpers + auth-retry
│   ├── database.ts            #   per-account SQLite (orders/trades/positions/funds)
│   ├── feed-client.ts         #   server-side feed client (subscribe/universe push)
│   ├── simfeed/ | dhan/ | shoonya/ | icici_breeze/   # adapters
├── mini-services/market-feed/ # Bun feed: ticks, candles, recorder, replay, sync hub
├── src/
│   ├── app/api/               # REST API routes (see docs/API.md)
│   ├── components/terminal/   # terminal SPA (views, panels, canvas chart, store)
│   ├── lib/services/          # capital, order router, symbol sync, option chain,
│   │                          # auto-rules, GTT, strategy engine, python runner…
│   └── instrumentation*.ts    # boot sequence + watchdogs
├── strategies/                # exported Python strategies
├── tests/                     # unit (bun test) + E2E smoke (bash)
└── docs/USER_GUIDE.md         # full terminal user guide · docs/API.md endpoint reference
```

## 6. Key features (quick index → details in docs/USER_GUIDE.md)

- **Multi-account order fan-out** with per-account capital sizing: 3 house modes (`PROFIT_ONLY`, `INITIAL_PLUS_PNL`, `INITIAL_WITH_LOSS_REDUCTION`) × capital source (fixed ₹ or % of live available cash); exits always bypass capital checks.
- **Strike Panel options desk**: ITM/ATM/OTM quick-add (CE ATM = floor, PE ATM = ceil of spot), per-side 100%-normalized % allocation or fixed-₹ mode, Deploy / Cancel / Swap / Exit per side, per-strike PnL.
- **Canvas chart engine**: candles/line/area, volume, indicators (SMA/EMA/VWAP/Bollinger/RSI/MACD/ADX), **ghost candles** (live always solid, ghost always hollow, any timeframe both directions with overlap carve-out), scales (price/%/inverted/points + draggable baseline), session/hour/range breaks, 28-tool drawing suite incl. long/short position tool (default 1:1.5 RR, 10% SL), draggable SL/target position markers that arm real reduce-only orders, synced crosshair, ≥3 future bars + ▶LIVE.
- **Auto bot**: time / index-range / premium-gate conditions, AND-combined, second-precision scheduling, strike lists per arm, optional entry/SL/target legs.
- **Paper trading replay**: record real ticks (per-session SQLite), replay any session (random or date-time range, 0.5–20× speed) as a synthetic live session.
- **Python strategies**: in-app builder + backend `python3` runner with feed SDK; signals route through the same capital-aware order router.
- **Admin**: account CRUD, copy-trade routing toggles, capital config, tick recorder, replay manager, broker OAuth sessions, audit log.
