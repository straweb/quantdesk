import { createServer } from 'http'
import { Server } from 'socket.io'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import { spawn } from 'child_process'

// ============================================================
// Market Feed Mini-Service (port 3003, bun runtime)
// - Simulated tick engine (random walk, per-symbol volatility)
// - Candle aggregation for 1m/3m/5m/15m/30m/1h/1d
// - Deterministic historical backfill (3 sessions of 1m bars)
// - Socket.io streaming for subscribed symbols
// - REST: health / universe / candles / ltp / quote / depth
//         /feed-source (active feed account — one at a time)
// In production this service hosts pluggable feed adapters
// (Dhan WebSocket, Shoonya WebSocket, ICICI Breeze stream);
// the sim feed is the default source and the sandbox fallback.
// ============================================================

interface UniverseEntry {
  symbol: string
  basePrice: number
  lotSize: number
  instrumentType: string
}

interface SymbolState {
  symbol: string
  instrumentType: string
  lotSize: number
  base: number
  ltp: number
  prevClose: number
  open: number
  high: number
  low: number
  vol: number
  vola: number // per-tick volatility
  bid: number
  ask: number
  lastTickDir: number
}

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

const PORT = Number(process.env.PORT || 3003) // socket.io (browser via Caddy)
const REST_PORT = Number(process.env.REST_PORT || 3004) // REST (Next.js server-side proxy)

// ---------- default universe (before master sync pushes the real one) ----------
const DEFAULT_UNIVERSE: UniverseEntry[] = [
  { symbol: 'NIFTY', basePrice: 24500, lotSize: 1, instrumentType: 'INDEX' },
  { symbol: 'BANKNIFTY', basePrice: 51800, lotSize: 1, instrumentType: 'INDEX' },
  { symbol: 'RELIANCE', basePrice: 2870, lotSize: 250, instrumentType: 'EQ' },
  { symbol: 'TCS', basePrice: 4150, lotSize: 175, instrumentType: 'EQ' },
  { symbol: 'HDFCBANK', basePrice: 1740, lotSize: 550, instrumentType: 'EQ' },
  { symbol: 'INFY', basePrice: 1870, lotSize: 400, instrumentType: 'EQ' },
  { symbol: 'SBIN', basePrice: 830, lotSize: 750, instrumentType: 'EQ' },
  { symbol: 'ICICIBANK', basePrice: 1265, lotSize: 700, instrumentType: 'EQ' },
]

const TF_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '1d': 86_400_000,
}

// ---------- seeded PRNG for deterministic history ----------
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

function volaFor(instrumentType: string): number {
  // per-250ms-tick volatility (annualizes to realistic daily moves)
  if (instrumentType === 'INDEX') return 0.00006
  if (instrumentType === 'FUT') return 0.0001
  if (instrumentType === 'CE' || instrumentType === 'PE') return 0.0007
  return 0.00012
}

function volaHist(instrumentType: string): number {
  // per 5s history sub-step
  if (instrumentType === 'INDEX') return 0.00018
  if (instrumentType === 'FUT') return 0.0003
  if (instrumentType === 'CE' || instrumentType === 'PE') return 0.0022
  return 0.00035
}

// ---------- state ----------
const g = globalThis as unknown as {
  __feedState: {
    states: Map<string, SymbolState>
    candles: Map<string, Candle[]> // key symbol|tf
    subs: Map<string, Set<string>> // socketId -> symbols
  } | undefined
}

if (!g.__feedState) {
  g.__feedState = { states: new Map(), candles: new Map(), subs: new Map() }
}
const S = g.__feedState

// ---------- active feed source (persisted; one at a time) ----------
const FEED_SRC_FILE = process.env.FEED_SRC_FILE || path.resolve(process.cwd(), '../../db/feed-source.json')
let feedSource = 'sim'
try {
  const raw = readFileSync(FEED_SRC_FILE, 'utf8')
  feedSource = (JSON.parse(raw) as { source?: string }).source ?? 'sim'
} catch { /* first boot — default 'sim' */ }

// ---------- sidecar supervisor: keep the Next.js dev server alive ----------
// This service is boot-spawned and outlives agent tool sessions (whose spawned
// processes get reaped at session boundaries), so it doubles as the dev-server
// watchdog: whenever :3000 stops answering, respawn `bun run dev` detached.
const PROJECT_ROOT = path.resolve(process.cwd(), '../..')
let devStarting = false

async function devHealthy(): Promise<boolean> {
  try {
    const r = await fetch('http://localhost:3000/api/auth/me', { signal: AbortSignal.timeout(2500) })
    return r.status < 500 // any HTTP response means the server is up
  } catch {
    return false
  }
}

function spawnDevServer() {
  if (devStarting) return
  devStarting = true
  console.log('[market-feed] :3000 down — spawning Next.js dev server…')
  try {
    const child = spawn('bun', ['run', 'dev'], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      // our own env may carry PORT=3003 — the dev script binds :3000 via -p
      env: { ...process.env, PORT: '3000' },
    })
    child.unref()
    child.on('error', e => console.error('[market-feed] dev spawn error:', e.message))
  } catch (e) {
    console.error('[market-feed] dev spawn failed:', e)
  } finally {
    // cooldown so a crashing server cannot trigger a tight respawn loop
    setTimeout(() => { devStarting = false }, 20_000)
  }
}

// watchdog itself is registered in the single-owner timer block at the bottom
// of this file (survives hot reloads without stacking)

const DAYS_BACK = 3

function bucketStart(ts: number, tf: string): number {
  const ms = TF_MS[tf] ?? 60000
  return Math.floor(ts / ms) * ms
}

function buildHistory(entry: UniverseEntry) {
  const rnd = mulberry32(hashStr(entry.symbol) % 2 ** 31)
  // independent stream for volume so adding index volume never perturbs the
  // deterministic price path (same rnd() call sequence as before)
  const vrnd = mulberry32((hashStr(entry.symbol) ^ 0x9e3779b9) >>> 0)
  const vola = volaHist(entry.instrumentType)
  const now = Date.now()
  const oneMin = TF_MS['1m']
  const startTs = bucketStart(now, '1m') - DAYS_BACK * 24 * 3600_000
  const bars: Candle[] = []
  let price = entry.basePrice * (0.995 + rnd() * 0.01)
  const MEAN_REV = 0.0006

  for (let t = startTs; t <= bucketStart(now, '1m'); t += oneMin) {
    const o = price
    let h = o, l = o, c = o
    // 12 sub-steps per minute
    for (let i = 0; i < 12; i++) {
      const shock = (rnd() - 0.5) * 2 * vola
      c = c * (1 + shock + MEAN_REV * (entry.basePrice - c) / entry.basePrice)
      h = Math.max(h, c)
      l = Math.min(l, c)
    }
    const v = Math.round((entry.instrumentType === 'INDEX' ? 2200 + vrnd() * 19000 : 400 + vrnd() * 2600) * (entry.lotSize > 1 ? 1 : 8))
    bars.push({ t, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v })
    price = c
  }
  S.candles.set(`${entry.symbol}|1m`, bars)
  return { last: bars[bars.length - 1]?.c ?? entry.basePrice, prevDayClose: entry.basePrice * 0.997 }
}

function r2(n: number) { return Math.round(n * 100) / 100 }

function loadUniverse(list: UniverseEntry[]) {
  for (const e of list) {
    if (S.states.has(e.symbol)) continue
    const { last, prevDayClose } = buildHistory(e)
    const bars = S.candles.get(`${e.symbol}|1m`)!
    const todayBars = bars.slice(-375)
    S.states.set(e.symbol, {
      symbol: e.symbol,
      instrumentType: e.instrumentType,
      lotSize: e.lotSize,
      base: e.basePrice,
      ltp: last,
      prevClose: r2(prevDayClose),
      open: todayBars[0]?.o ?? last,
      high: Math.max(...todayBars.map(b => b.h)),
      low: Math.min(...todayBars.map(b => b.l)),
      vol: todayBars.reduce((s, b) => s + b.v, 0),
      vola: volaFor(e.instrumentType),
      bid: r2(last * 0.9995),
      ask: r2(last * 1.0005),
      lastTickDir: 1,
    })
  }
}

// aggregate 1m -> tf (cached arrays appended on rollover)
function getSeries(symbol: string, tf: string): Candle[] {
  const key = `${symbol}|${tf}`
  if (tf === '1m') return S.candles.get(key) ?? []
  const base = S.candles.get(`${symbol}|1m`) ?? []
  let series = S.candles.get(key)
  if (!series) {
    series = aggregate(base, tf)
    S.candles.set(key, series)
  }
  return series
}

function aggregate(base: Candle[], tf: string): Candle[] {
  const ms = TF_MS[tf]
  const out: Candle[] = []
  let cur: Candle | null = null
  for (const b of base) {
    const bs = bucketStart(b.t, tf)
    if (!cur || cur.t !== bs) {
      if (cur) out.push(cur)
      cur = { t: bs, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }
    } else {
      cur.h = Math.max(cur.h, b.h)
      cur.l = Math.min(cur.l, b.l)
      cur.c = b.c
      cur.v += b.v
    }
  }
  if (cur) out.push(cur)
  return out
}

// ---------- tick engine ----------
function tickOnce() {
  const now = Date.now()
  for (const st of S.states.values()) {
    const shock = (Math.random() - 0.5) * 2 * st.vola
    const meanRev = (st.base - st.ltp) / st.base * 0.0006
    st.ltp = r2(st.ltp * (1 + shock + meanRev))
    st.lastTickDir = shock >= 0 ? 1 : -1
    st.high = Math.max(st.high, st.ltp)
    st.low = Math.min(st.low, st.ltp)
    st.bid = r2(st.ltp - Math.max(0.05, st.ltp * 0.0004))
    st.ask = r2(st.ltp + Math.max(0.05, st.ltp * 0.0004))
    // per-tick traded volume — EQ/FUT/OPT scale with lot size, indices get a
    // synthetic flow calibrated to match the historical per-minute volumes
    // (history: ~2200-21000/min for INDEX, ~3200-24000/min for lot>1 EQ)
    const dv = st.instrumentType !== 'INDEX'
      ? Math.round(Math.random() * st.lotSize * 2)
      : Math.round(10 + Math.random() * 60)
    st.vol += dv

    // update 1m candle
    const key = `${st.symbol}|1m`
    const bars = S.candles.get(key)
    if (bars) {
      const bs = bucketStart(now, '1m')
      let cur = bars[bars.length - 1]
      if (!cur || cur.t !== bs) {
        cur = { t: bs, o: st.ltp, h: st.ltp, l: st.ltp, c: st.ltp, v: dv }
        bars.push(cur)
        // keep memory bounded
        if (bars.length > DAYS_BACK * 1440 + 500) bars.splice(0, 200)
        // invalidate higher tf caches lazily (they re-aggregate tail)
        for (const tf of Object.keys(TF_MS)) {
          if (tf === '1m') continue
          const sk = `${st.symbol}|${tf}`
          const series = S.candles.get(sk)
          if (series) {
            const b2 = bucketStart(now, tf)
            const last2 = series[series.length - 1]
            if (last2 && last2.t === b2) {
              last2.h = Math.max(last2.h, st.ltp)
              last2.l = Math.min(last2.l, st.ltp)
              last2.c = st.ltp
              last2.v += dv
            } else {
              series.push({ t: b2, o: st.ltp, h: st.ltp, l: st.ltp, c: st.ltp, v: dv })
            }
          }
        }
      } else {
        cur.h = Math.max(cur.h, st.ltp)
        cur.l = Math.min(cur.l, st.ltp)
        cur.c = st.ltp
        cur.v += dv
      }
    }
  }
}

function subscribedSymbols(): Set<string> {
  const set = new Set<string>()
  for (const syms of S.subs.values()) for (const s of syms) set.add(s)
  return set
}

// ---------- http server ----------
const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json')

  const json = (code: number, obj: unknown) => {
    res.statusCode = code
    res.end(JSON.stringify(obj))
  }

  if (url.pathname === '/health') return json(200, { ok: true, symbols: S.states.size, ts: Date.now() })

  // ---- active feed source (which account the terminal pulls data from) ----
  // Persisted to a shared JSON file so the Next.js API can read/write it too.
  // 'sim' = built-in simulated feed; otherwise a BrokerAccount id whose
  // adapter websocket is used when that broker feed is connected.
  if (url.pathname === '/feed-source') {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        try {
          const { source } = JSON.parse(body) as { source?: string }
          if (!source || typeof source !== 'string') return json(400, { ok: false, error: 'source required' })
          feedSource = source
          try {
            mkdirSync(path.dirname(FEED_SRC_FILE), { recursive: true })
            writeFileSync(FEED_SRC_FILE, JSON.stringify({ source: feedSource, updatedAt: new Date().toISOString() }, null, 2))
          } catch (e) {
            console.error('[market-feed] feed-source persist failed:', e)
          }
          console.log(`[market-feed] feed source -> ${feedSource}`)
          json(200, { ok: true, source: feedSource })
        } catch (e) {
          json(400, { ok: false, error: String(e) })
        }
      })
      return
    }
    return json(200, { source: feedSource })
  }

  if (url.pathname === '/universe') {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        try {
          const { universe } = JSON.parse(body) as { universe: UniverseEntry[] }
          loadUniverse(universe)
          json(200, { ok: true, symbols: S.states.size })
        } catch (e) {
          json(400, { ok: false, error: String(e) })
        }
      })
      return
    }
    return json(200, { universe: [...S.states.values()].map(s => ({ symbol: s.symbol, basePrice: s.ltp, lotSize: s.lotSize, instrumentType: s.instrumentType })) })
  }

  if (url.pathname === '/ltp') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
    const quotes: Record<string, unknown> = {}
    for (const s of symbols) {
      const st = S.states.get(s)
      if (st) {
        quotes[s] = { symbol: s, ltp: st.ltp, prevClose: st.prevClose, open: st.open, high: st.high, low: st.low, vol: st.vol, ts: Date.now() }
      }
    }
    return json(200, { quotes })
  }

  if (url.pathname === '/quote') {
    const s = url.searchParams.get('symbol') ?? ''
    const st = S.states.get(s)
    if (!st) return json(404, { error: 'unknown symbol' })
    return json(200, {
      symbol: s, ltp: st.ltp, prevClose: st.prevClose, open: st.open, high: st.high, low: st.low, vol: st.vol,
      bid: st.bid, ask: st.ask,
      depth: {
        buys: [0, 1, 2, 3, 4].map(i => ({ price: r2(st.bid - i * (st.ltp * 0.0005 + 0.05)), qty: Math.round(50 + Math.random() * 900) })),
        sells: [0, 1, 2, 3, 4].map(i => ({ price: r2(st.ask + i * (st.ltp * 0.0005 + 0.05)), qty: Math.round(50 + Math.random() * 900) })),
      },
      ts: Date.now(),
    })
  }

  if (url.pathname === '/candles') {
    const symbol = url.searchParams.get('symbol') ?? ''
    const tf = url.searchParams.get('tf') ?? '5m'
    const limit = Math.min(3000, Number(url.searchParams.get('limit') ?? 500))
    if (!S.states.has(symbol)) return json(404, { error: `unknown symbol ${symbol}` })
    const series = getSeries(symbol, tf)
    return json(200, { symbol, tf, candles: series.slice(-limit) })
  }

  json(404, { error: 'not found' })
})

// ---------- socket server (socket.io, path '/' per gateway convention) ----------
const socketServer = createServer()

const io = new Server(socketServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

io.on('connection', socket => {
  S.subs.set(socket.id, new Set())

  socket.on('subscribe', (symbols: string[]) => {
    const set = S.subs.get(socket.id)
    if (set) for (const s of symbols || []) set.add(s)
    socket.emit('subscribed', { symbols, count: set?.size ?? 0 })
  })

  socket.on('unsubscribe', (symbols: string[]) => {
    const set = S.subs.get(socket.id)
    if (set) for (const s of symbols || []) set.delete(s)
  })

  socket.on('disconnect', () => S.subs.delete(socket.id))
})

loadUniverse(DEFAULT_UNIVERSE)

// ---- timers: bun --hot stacks intervals across reloads — deregister the
// previous module's loops first (globalThis survives hot reloads) ----
interface HotTimers { tick?: ReturnType<typeof setInterval>; stream?: ReturnType<typeof setInterval>; watch?: ReturnType<typeof setInterval> }
const hot = g as unknown as { __feedTimers?: HotTimers }
if (hot.__feedTimers) {
  if (hot.__feedTimers.tick) clearInterval(hot.__feedTimers.tick)
  if (hot.__feedTimers.stream) clearInterval(hot.__feedTimers.stream)
  if (hot.__feedTimers.watch) clearInterval(hot.__feedTimers.watch)
}
hot.__feedTimers = {}

// tick loop 250ms — streams subscribed symbols
hot.__feedTimers.tick = setInterval(tickOnce, 250)
hot.__feedTimers.stream = setInterval(() => {
  const syms = subscribedSymbols()
  if (syms.size === 0) return
  const ticks: unknown[] = []
  const now = Date.now()
  for (const s of syms) {
    const st = S.states.get(s)
    if (!st) continue
    ticks.push({ symbol: s, ltp: st.ltp, prevClose: st.prevClose, open: st.open, high: st.high, low: st.low, vol: st.vol, bid: st.bid, ask: st.ask, ts: now })
  }
  if (ticks.length) io.emit('ticks', ticks)
}, 250)

// dev-server watchdog — every 10s, respawn `bun run dev` when :3000 is dark
hot.__feedTimers.watch = setInterval(() => {
  void devHealthy().then(up => { if (!up) spawnDevServer() })
}, 10_000)

httpServer.listen(REST_PORT, () => {
  console.log(`[market-feed] REST listening on :${REST_PORT} with ${S.states.size} symbols`)
})
socketServer.on('error', e => console.error('[market-feed] socket.io error:', (e as Error).message))
httpServer.on('error', e => console.error('[market-feed] REST error:', (e as Error).message))
socketServer.listen(PORT, () => {
  console.log(`[market-feed] socket.io listening on :${PORT}`)
})

process.on('SIGTERM', () => { httpServer.close(() => process.exit(0)); socketServer.close(() => process.exit(0)) })
process.on('SIGINT', () => { httpServer.close(() => process.exit(0)); socketServer.close(() => process.exit(0)) })
// reload-probe 1792602789
