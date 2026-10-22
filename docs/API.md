# API Reference

Two surfaces:

1. **Next.js REST API** — `http://localhost:3000/api/*` (auth: HMAC session cookie `zterm_session` set by `POST /api/auth/login`; unauthorized calls return `401 {"error": "Unauthorized — login as admin"}`).
2. **Feed mini-service** — REST on `:3004` (server-side only) and **socket.io** on `:3003` (browser reaches it through Caddy: `io('/?XTransformPort=3003')`).

---

## 1. Next.js REST endpoints

### Auth

| Method & path | Body / query | Description |
|---|---|---|
| `POST /api/auth/login` | `{username, password}` | sets `zterm_session` cookie |
| `POST /api/auth/logout` | — | clears session |
| `GET /api/auth/me` | — | current user or `null` |

### Accounts & capital

| Method & path | Description |
|---|---|
| `GET /api/accounts` | all accounts + capital state (mode, base/pct, available cash, usable) |
| `POST /api/accounts` | create account (per-broker credential fields, encrypted at rest) |
| `GET/PATCH/DELETE /api/accounts/[id]` | read / update (label, `isActive` routing, credentials, `capitalBase`, `capitalPct`, capital+mode) / delete |
| `GET /api/funds` | aggregated per-account funds ledgers |
| `GET /api/portfolio` | live holdings + live marks + open positions |
| `GET /api/margin` | per-account broker margin vs usable (sandbox estimate fallback) |

### Broker sessions & diagnostics

| Method & path | Description |
|---|---|
| `GET /api/broker-auth` | per live account: auth status + flow descriptor + generated login URL |
| `POST /api/broker-auth` | `{accountId, step:'consent'\|'complete', …}` — OAuth-style consent / session creation |
| `GET /api/broker-logs` | per-account adapter logs |
| `GET /api/broker-orderbook` | live order book for one account |
| `GET /api/admin/audit` | order audit trail |

### Orders

| Method & path | Body | Description |
|---|---|---|
| `GET /api/orders` | — | aggregated master + leg orders |
| `POST /api/orders` | `{symbol, exchange, side, orderType, productType, lots?, qty?, price?, triggerPrice?, capitalPct?, absoluteAmount? ("abs:<₹>" tag), source?}` | place master order → fan-out to enabled accounts (capital-sized) |
| `POST /api/orders/cancel` | `{accountId, orderId}` | cancel one leg |
| `POST /api/orders/cancel-all` | `{symbols?}` | cancel all open orders (optionally filtered) |
| `POST /api/orders/squareoff` | `{symbols?}` | market-close open positions (optionally filtered) |
| `GET /api/positions` · `GET /api/trades` | — | aggregated positions / executed trades |

### Market data proxies (→ feed :3004)

| Method & path | Query | Description |
|---|---|---|
| `GET /api/market/candles` | `symbol, tf, bars` | OHLCV series |
| `GET /api/market/quote` | `symbols` (csv) | LTP/OHLC/bid/ask/volume + lotSize + instrumentType |
| `GET /api/market/ltp` | `symbols` | light LTP batch |
| `GET /api/market/status` | — | feed health mirror |
| `GET /api/market/index` | `symbols` | index constituents + contribution pts |
| `GET /api/market/fno` | — | F&O universe grouped by exchange (expiry, contracts, lot, spot) |

### Options desk

| Method & path | Query / body | Description |
|---|---|---|
| `GET /api/options/underlyings` | — | F&O underlyings + expiries |
| `GET /api/options/chain` | `underlying, expiry?, strikes?` | chain quotes + `ceAtm/peAtm` (CE floor / PE ceil), step, lot |
| `POST /api/options/ensure-strike` | `{underlying, strike, expiry?}` | create contracts on demand (master + mappings + feed universe) |

### Symbols

| Method & path | Description |
|---|---|
| `GET /api/symbols` | browse master symbols (`?symbols=a,b` for explicit list, `?q=` search, exchange/type filters) |
| `POST /api/symbols/sync` | master-contracts sync (indices/eq/futs/weekly-monthly options/BFO/MCX/CDS) → republishes feed universe |
| `GET /api/symbols/resolve` | broker-specific token mapping for a symbol |

### Automation

| Method & path | Description |
|---|---|
| `GET/POST /api/autorules` · `PATCH/DELETE /api/autorules/[id]` | auto-bot rules (TIME / INDEX / INDEX_RANGE / COMPOUND conditions, actions BUY/SELL/DEPLOY/CANCEL, strikes list, entry/SL/TGT legs, repeatDaily) |
| `GET/POST /api/gtt` · `PATCH/DELETE /api/gtt/[id]` | GTT orders (edge-trigger on LTP, arm/disarm, repeatDaily) |
| `GET/PATCH /api/copytrade` | copy-trade master/slave routing matrix |
| `GET/POST /api/tickrecorder` | tick recorder config + recorded sessions (POST: toggle / symbols) |
| `GET/POST /api/replay` | paper-trading replay (POST: `{action:'start'\|'stop', file?, random?, fromTs?, toTs?, speed 0.5–20}`) |
| `GET /api/stats/session` | session win rate, realized/unrealized/net ₹, pts, charges, per-account breakdown |
| `GET /api/feed` · `POST /api/feed` | active feed source list (includes disconnected accounts) / set source |

### Strategies

| Method & path | Description |
|---|---|
| `GET/POST /api/strategies` · `GET/PATCH/DELETE /api/strategies/[id]` | strategy CRUD |
| `GET /api/strategies/[id]/python` | exported Python code |
| `POST /api/strategy/run` | `{id?, code?, symbol, tf, bars, dryRun?}` — runs in a `python3` subprocess with the SDK; `signal()` routes orders (source `PYTHON`) |

---

## 2. Feed mini-service — REST (:3004)

| Path | Method | Description |
|---|---|---|
| `/health` | GET | `{ok, symbols, ts}` — watchdog target |
| `/candles` | GET | `?symbol&tf&bars` OHLCV (deterministic 3-session 1m backfill + aggregated TFs) |
| `/ltp` · `/quote` · `/depth` | GET | batch market data |
| `/feed-source` | GET/POST | active feed account (persisted to `db/feed-source.json`) |
| `/universe` | POST | publish symbol universe (from master sync) |
| `/tick-config` | GET/POST | tick recorder on/off + symbol list (`db/ticks/tick-recorder.json`) |
| `/tick-sessions` | GET | recorded session DBs |
| `/tick-sample` | GET | sample rows from a session (replay preview) |
| `/replay-config` | POST | `start/stop` replay `{file?, random?, fromTs?, toTs?, speed}` |
| `/replay-status` | GET | replay progress |

## 3. Socket.io channels (:3003)

**Emits (client → server)**

| Event | Payload | Purpose |
|---|---|---|
| `subscribe` / `unsubscribe` | `string[]` symbols | tick stream control |
| `sync:sub` | `{underlyings, indices, …}` | register per-socket sync parameters |

**Events (server → client)**

| Event | Rate | Payload |
|---|---|---|
| `ticks` | ~250 ms | `Record<symbol, Tick>` (ltp/ohlc/bid/ask/vol) |
| `sync:core` | 1 s | accounts (incl. capital base/pct/cash), positions, orders, trades, funds, session stats |
| `sync:chain` | 1 s | option chain meta per underlying (CE floor / PE ceil ATM, ±15 steps) |
| `sync:index` | 1 s | index constituents + points contribution |

Client helpers live in `src/components/terminal/lib/socket.ts` (ticks) and `src/components/terminal/lib/sync.ts` (`onSync` / `useSyncChannel` / `useSyncData`, with REST fallback).
