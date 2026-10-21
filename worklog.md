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

