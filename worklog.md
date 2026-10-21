# Worklog

---
Task ID: 1
Agent: main (Z.ai)
Task: Build multi-broker trading terminal (sim feed, ICICI Breeze, Dhan, Shoonya) with copy trading, capital sizing house rules, from-scratch chart, admin, master contracts sync, python strategy builder. Reference: straweb/hedging (OpenAlgo fork, hedging branch) — adapted to Next.js 16 + TS sandbox runtime (Flask backend replaced by service-oriented Next.js API + mini-services; frontend stack identical: React 19 + TS + Tailwind 4 + shadcn/ui).

Work Log:
- Initialized fullstack env (init script), inspected package.json / Caddyfile / dev.sh
- Runtimes: Node 24.21 (Next dev), Bun 1.3.14 (mini-services), Python 3.12
- Plan: Prisma master DB + per-broker SQLite via node:sqlite (db/brokers/{type}/{accountId}.db)
- Architecture: brokers/ plugin folder (OpenAlgo style), services/ modules, mini-services/market-feed on port 3003 (socket.io), strategy scheduler via instrumentation.ts
- Built Prisma master schema (BrokerAccount, CapitalConfig, SymbolMaster, SymbolMapping, CopyTradeConfig, Strategy, StrategyLog, SyncLog, OrderAudit) + db push
- Core: charges engine (STT/GST/stamp/txn per segment), capital sizing service with 3 house modes (PROFIT_ONLY, INITIAL_PLUS_PNL, INITIAL_WITH_LOSS_REDUCTION), crypto (AES-256-GCM creds, scrypt passwords, HMAC sessions)
- brokers/: registry + simfeed/dhan/shoonya/icici_breeze adapters (real API shapes for Dhan v2, Noren, Breeze; sandbox fallback fills via shared execution engine writing orders/trades/positions/funds per-account SQLite DBs)
- Services: symbol master sync (216 symbols: indices/eq/futs/NIFTY weeklies/BANKNIFTY monthlies; 864 broker mappings), copy-trading order router (fan-out + per-account sizing), bootstrap seeding, strategy engine (1s scheduler, time-based entry/exit, SL/target/trailing, python export to /strategies)
- mini-services/market-feed: socket.io :3003 + REST :3004, deterministic 3-day 1m backfill, live ticks 250ms with mean reversion, TF aggregation 1m..1d, depth
- API routes: auth, accounts CRUD, copytrade, symbols(+sync/resolve), orders(+squareoff/cancel-all), positions/trades/funds aggregates, strategies CRUD+python, market proxies, status, audit, broker-logs
- Frontend SPA: auth gate, top bar (Terminal/Strategy/Admin + FEED LIVE status), workspace tabs (persisted), from-scratch canvas chart (candles/line/area, volume, crosshair OHLCV legend, wheel zoom, drag pan, SMA20/50, position avg-price markers, last-price label, click-to-set-limit), watchlist+depth, order pad (AUTO house sizing preview per account), bottom panel (orders/trades/positions/funds/broker-logs), quick buttons (B/S, cancel all, square off all, kill switch badge), admin view, strategy builder UI + python viewer
- Fixed: TDZ circular registry import (brokers/index.ts), @brokers/* tsconfig alias, missing createHmac import, symbolMap.masterSymbol destructure bug, socket path conflict (REST split to :3004), scheduler lazy-start via bootstrap(), reduceOnly bypass for exits/square-offs (capital checks must never block exits), absolute capitalAmount clamped to usable (house rule)
- E2E verified via agent-browser: login, live ticks, chart, order fan-out (203/40/0 units sized per house rules), positions PnL, square-off settlement with charges, admin toggles, strategy create→entry→scheduled exit→python export

Stage Summary:
- Working terminal: http://localhost:81 (gateway) — FEED LIVE via socket.io, orders fan out to all enabled accounts, per-account SQLite DBs under db/brokers/
- Key artifacts: brokers/ (4 adapters + execution engine), src/lib/services/ (capital, order-router, symbol, strategy, bootstrap), mini-services/market-feed, strategies/*.py exports
- Verified: PROFIT_ONLY acct = 0 usable after losses (skips legs), loss-reducing acct = initial − losses incl charges, initial+PnL acct compounds; exits always bypass capital checks
- Default login: admin / admin123

---
Task ID: 2
Agent: main (Z.ai)
Task: Fix user-reported issues in preview tab — React hydration error + login with admin/admin123 failing.

Work Log:
- Diagnosed: backend auth fine (login 200 via :3000 and :81), admin user seeded; failure was client-side
- Root causes found: (a) zustand persist rehydrated synchronously from localStorage before first client render → hydration mismatch when logged-in tab had divergent persisted workspaces; (b) sonner Toaster used next-themes useTheme() without a mounted ThemeProvider (hydration risk); (c) stale preview tab after dev-server restart → dead HMR chunks + hardening gaps (gateway HTML error pages returned unparseable responses to login fetch)
- Fixed store.ts: persist skipHydration:true + manual useTerminal.persist.rehydrate() in Shell useEffect
- Fixed sonner.tsx: pinned theme="dark" (no next-themes useTheme)
- Fixed layout.tsx: suppressHydrationWarning on <body> (browser-extension attribute injection guard)
- Hardened client-api.ts: fetchJson wrapper — cache:'no-store', readable gateway-502 errors, 1 auto-retry on transient 5xx/network errors
- Hardened auth routes: login/me now force-dynamic + nodejs runtime, always-JSON error responses (503 fallback), cookie secure flag set protocol-aware (x-forwarded-proto) so HTTPS preview and HTTP localhost both work

Stage Summary:
- E2E verified: fresh login admin/admin123 OK (:3000 + :81), wrong password shows "Invalid credentials", divergent localStorage reload → ZERO hydration errors, logout→login cycle OK, console clean
- All fixes are SSR-safe; persisted workspaces rehydrate post-mount (1-frame default flash, acceptable)

---
Task ID: 3
Agent: main (Z.ai)
Task: F&O strikes panel — dynamic strike add (CE/PE ATM±1-5 + specific strike), quick deploy bar (Deploy CE/PE, Cancel CE, PE Swap) with % allocation sizing, strike rows (LTP, day H/L, B/S/X, edit open position), spot chart + default-open ATM CE (left) / PE (right) mini charts.

Work Log:
- symbol-service: seeded stock options for 10 F&O equities (monthly expiry, price-based strike step via strikeStepFor), exported optionPremium/strikeStepFor; resync grew universe 216→636 symbols, 2544 broker mappings
- option-service.ts (new): listOptionUnderlyings (12 F&O underlyings), getChainMeta (spot→ATM via min-gap step, expiries, lot), getChainQuotes (batch per-strike CE/PE LTP+H/L+chg), ensureOptionContracts (dynamic master rows + broker mappings + feed universe publication for any user strike)
- API: /api/options/underlyings, /api/options/chain (?underlying&expiry&strikes, includes atmRow for minis), /api/options/ensure-strike (POST)
- order-router: capitalPct param → sharePct sizing (per-account % of usable capital); reduceOnly legs now CAPPED at each account's own held qty (never flips flat account short — found live in E2E); squareOffAll + cancelAllOrders accept symbols filter; routes updated
- strikes-panel.tsx (new, right dock tab): underlying/expiry selectors, Spot/ATM/step/lot bar, CE+PE quick-add rows [-5..ATM..+5], specific-strike input (snaps to step, creates contracts on demand), rows w/ enable toggle + alloc% + strike + offset + LTP + H/L + position badge (L/S lots) + B/S/X + inline editor (position info, Δ lots/leg apply, exit full, remove, per-row alloc%); deploy bar: Deploy CE / Deploy PE (capitalPct per enabled strike), Cancel CE (filtered cancel), PE Swap (square-off CE syms → deploy PE, auto-adds ATM PE if list empty)
- option-mini-charts.tsx (new): 132px strip under spot chart for F&O underlyings — ATM CE left, ATM PE right, mini-mode CanvasChart (1m, no volume/crosshair/time axis), header shows strike/type/expiry/lot/LTP/chg, click loads option into main chart; ATM follows spot re-keying
- canvas-chart: added mini prop (thinner axes, fewer ticks, no crosshair/volume/time labels); terminal-view: RightDock tabs (Strikes | Order Pad, QuickButtons always visible), ATM toggle for minis, optionUnderlyings query gates the strip
- store: WorkspaceCfg.strikes (per-workspace persisted strike list: underlying, expiry, allocPct, rows[]) + showOptionMinis; mkWs defaults

Stage Summary:
- E2E verified via browser: NIFTY chain (spot 24,499 → ATM 24500 step 50 lot 75), CE ATM + PE +1 add, Deploy CE → 34/6 lots on 2 accounts by house rules, PE Swap → CE flat + PE 1350@87.2, Δ-3/leg reduce capped per account (router fix), Exit full → all flat, dynamic 25200 contracts created+quoted, mini charts live both sides
- Console clean, no hydration errors, FEED LIVE on gateway path (:81). FEED DOWN on :3000 direct is expected (socket.io proxies only via Caddy XTransformPort)

