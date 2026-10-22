import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { createDecipheriv, createHash } from 'node:crypto'
// @ts-ignore bun runtime builtin
import { Database } from 'bun:sqlite'
import { breezeRequest, breezeInstrumentParams, parseBreezeQuoteRow, firstSuccess, isAuthError, type BreezeCreds } from '../../brokers/icici_breeze/breeze'

// ============================================================
// LIVE BROKER FEED — real market data for live broker accounts.
//
// When the active feed source is a broker account (not 'sim'), this
// engine polls that broker's quote APIs and pushes the results into
// the SAME tick pipeline as the sim engine (SymbolState + 1m candles
// + the 250ms socket stream), so charts/watchlists/panels all go
// live without any client change. Symbols fed by a live broker are
// skipped by the random-walk engine (liveFedSymbols) — and when a
// real broker is the source the random walk is OFF entirely (no sim
// fallback), the same rule the admin Live-Only switch enforces.
//
//   DHAN   POST api.dhan.co/v2/marketfeed/quote  (batched per segment)
//   SHOONYA  POST NorenWClientTP/GetQuote (jKey session, per symbol)
//   ICICI   GET breezeapi/api/v1/quotes (SDK checksum headers, body params)
//
// Everything is logged: [BROKER][feed] lines to the console, rolling
// diagnostics kept per account, and a /feed-status REST endpoint
// exposes { source, connected, lastTickTs, lastError, symbols } so
// the FEED chip can show exactly why data is (not) flowing.
// Symbol mapping comes from the master DB (SymbolMapping — real
// scrip-master tokens after a sync) and is re-read every 2 min;
// credentials are decrypted with TERMINAL_SECRET and re-read every
// 60 s (a fresh admin session is picked up live).
// ============================================================

export interface LiveFeedCtx {
  S: { states: Map<string, { symbol: string; instrumentType: string; lotSize: number; base: number; ltp: number; prevClose: number; open: number; high: number; low: number; vol: number; vola: number; bid: number; ask: number; lastTickDir: number }>; candles: Map<string, { t: number; o: number; h: number; l: number; c: number; v: number }[]>; subs: Map<string, Set<string>> }
  subscribed: () => Set<string>
  bucketStart: (ts: number, tf: string) => number
  r2: (n: number) => number
  getTickCfg: () => { enabled: boolean; symbols: string[] }
}

interface MappingRow { masterSymbol: string; exchange: string; instrumentType: string; lotSize: number; brokerSymbol: string; brokerToken: string }
interface FeedStatus {
  source: string
  brokerType: string | null
  connected: boolean
  lastTickTs: number | null
  lastError: string | null
  errorTs: number | null
  symbols: number
  polls: number
  errors: number
  startedAt: number
  log: string[]
}

const TF_MS: Record<string, number> = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '1d': 86_400_000 }

const g = globalThis as unknown as {
  __liveFeed?: {
    ctx: LiveFeedCtx | null
    timer?: ReturnType<typeof setInterval>
    status: FeedStatus
    liveFed: Set<string>
    mappings: Map<string, MappingRow>
    mappingsTs: number
    creds: Record<string, string> | null
    credsTs: number
    brokerType: string
    accountId: string
    lastVol: Map<string, number>
    inflight: boolean
    simDisabled: boolean
    authFails: number
    backoffUntil: number
  }
}

function st(): NonNullable<typeof g.__liveFeed> {
  if (!g.__liveFeed) {
    g.__liveFeed = {
      ctx: null,
      status: { source: 'sim', brokerType: null, connected: false, lastTickTs: null, lastError: null, errorTs: null, symbols: 0, polls: 0, errors: 0, startedAt: Date.now(), log: [] },
      liveFed: new Set(),
      mappings: new Map(),
      mappingsTs: 0,
      creds: null,
      credsTs: 0,
      brokerType: '',
      accountId: '',
      lastVol: new Map(),
      inflight: false,
      simDisabled: false,
      authFails: 0,
      backoffUntil: 0,
    }
  }
  const s = g.__liveFeed
  // hot-reload migration: a pre-existing global state misses the newer fields
  if (s.authFails == null) s.authFails = 0
  if (s.backoffUntil == null) s.backoffUntil = 0
  return s
}

function dbRoot(): string {
  return path.resolve(process.cwd(), '../../db')
}

function pushLog(line: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): void {
  const s = st()
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`
  s.status.log.unshift(`${level} ${stamped}`)
  if (s.status.log.length > 60) s.status.log.length = 60
  if (level === 'ERROR') console.error(`[live-feed] ${stamped}`)
  else if (level === 'WARN') console.warn(`[live-feed] ${stamped}`)
  else console.log(`[live-feed] ${stamped}`)
  // mirror into the account's broker_logs (best effort)
  if (s.accountId && s.brokerType) {
    try {
      const dir = path.join(dbRoot(), 'brokers', s.brokerType.toLowerCase())
      if (existsSync(dir)) {
        const dbh = new Database(path.join(dir, `${s.accountId}.db`))
        dbh.exec('PRAGMA busy_timeout = 2000;')
        dbh.prepare(`INSERT INTO broker_logs (ts, level, message) VALUES (?, ?, ?)`)
          .run(new Date().toISOString(), level === 'INFO' ? 'INFO' : level, `feed: ${line}`)
        dbh.close()
      }
    } catch { /* logging must never break the feed */ }
  }
}

// ---------- credential decryption (same AES-256-GCM as the main app) ----------
const SECRET = process.env.TERMINAL_SECRET || 'zterm-default-secret-change-in-prod'
const KEY = createHash('sha256').update(SECRET).digest()

function decryptJson<T = Record<string, string>>(payload: string | null | undefined): T | null {
  if (!payload) return null
  try {
    const [ivB64, tagB64, dataB64] = payload.split('.')
    const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'))
    d.setAuthTag(Buffer.from(tagB64, 'base64'))
    const dec = Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()])
    return JSON.parse(dec.toString('utf8')) as T
  } catch {
    return null
  }
}

export { decryptJson }

// ---------- master DB access (read-only) ----------
function openRO(p: string): Database | null {
  try {
    if (!existsSync(p)) return null
    return new Database(p, { readonly: true })
  } catch { return null }
}

function loadCreds(brokerType: string, accountId: string): Record<string, string> | null {
  const master = openRO(path.join(dbRoot(), 'custom.db'))
  if (!master) return null
  try {
    const row = master.prepare('SELECT credentialsEnc FROM BrokerAccount WHERE id = ?').get(accountId) as { credentialsEnc?: string } | undefined
    return decryptJson(row?.credentialsEnc ?? null)
  } catch { return null } finally { master.close() }
}

function loadMappings(brokerType: string): void {
  const s = st()
  const master = openRO(path.join(dbRoot(), 'custom.db'))
  if (!master) return
  try {
    const rows = master.prepare(`
      SELECT sm.symbol AS masterSymbol, sm.exchange AS exchange, sm.instrumentType AS instrumentType,
             sm.lotSize AS lotSize, mp.brokerSymbol AS brokerSymbol, mp.brokerToken AS brokerToken
      FROM SymbolMapping mp JOIN SymbolMaster sm ON sm.id = mp.masterId
      WHERE mp.brokerType = ?
    `).all(brokerType) as MappingRow[]
    s.mappings.clear()
    for (const r of rows) s.mappings.set(r.masterSymbol, r)
    s.mappingsTs = Date.now()
    pushLog(`symbol mappings loaded — ${rows.length} for ${brokerType}`)
  } catch (e) {
    pushLog(`mapping load failed: ${e instanceof Error ? e.message : String(e)}`, 'WARN')
  } finally { master.close() }
}

// ---------- quote application (mirrors tickOnce candle logic) ----------
/**
 * Create a REAL market-data state for a symbol that has never been fed
 * before (live mode opens any of the synced master symbols). The state is
 * built ONLY from the broker's own quote — no synthetic history, no sim
 * seed: candles start empty and accumulate from real ticks.
 */
function ensureLiveState(symbol: string, m: MappingRow | undefined, q: { ltp: number; bid?: number; ask?: number; open?: number; high?: number; low?: number; prevClose?: number }): boolean {
  const s = st()
  const ctx = s.ctx
  if (!ctx || ctx.S.states.has(symbol)) return true
  const ltp = ctx.r2(q.ltp)
  const state = {
    symbol,
    instrumentType: m?.instrumentType ?? 'EQ',
    lotSize: m?.lotSize && m.lotSize > 0 ? m.lotSize : 1,
    base: ltp,
    ltp,
    prevClose: q.prevClose && q.prevClose > 0 ? ctx.r2(q.prevClose) : ltp,
    open: q.open && q.open > 0 ? ctx.r2(q.open) : ltp,
    high: q.high && q.high > 0 ? ctx.r2(q.high) : ltp,
    low: q.low && q.low > 0 ? ctx.r2(q.low) : ltp,
    vol: 0,
    vola: 0, // sim walk field — live symbols are never walked (liveFed set)
    bid: q.bid && q.bid > 0 ? ctx.r2(q.bid) : ltp,
    ask: q.ask && q.ask > 0 ? ctx.r2(q.ask) : ltp,
    lastTickDir: 1,
  }
  ctx.S.states.set(symbol, state)
  // empty candle series — real bars appear as real ticks arrive
  if (!ctx.S.candles.has(`${symbol}|1m`)) ctx.S.candles.set(`${symbol}|1m`, [])
  pushLog(`live state created for ${symbol} (${state.instrumentType}, lot ${state.lotSize}) from real quote`)
  return true
}

function applyQuote(symbol: string, q: { ltp?: number; bid?: number; ask?: number; open?: number; high?: number; low?: number; prevClose?: number; volume?: number }, m?: MappingRow): boolean {
  const s = st()
  const ctx = s.ctx
  if (!ctx) return false
  const state = ctx.S.states.get(symbol)
  if (!state) {
    // unknown symbol (opened from the synced master list) — build the state
    // from this real quote so the chart/depth/watchlist can go live
    if (!q.ltp || !Number.isFinite(q.ltp) || q.ltp <= 0) return false
    ensureLiveState(symbol, m, { ltp: q.ltp, bid: q.bid, ask: q.ask, open: q.open, high: q.high, low: q.low, prevClose: q.prevClose })
  }
  const st2 = ctx.S.states.get(symbol)
  if (!st2 || !q.ltp || !Number.isFinite(q.ltp) || q.ltp <= 0) return false
  const now = Date.now()
  const dv = q.volume != null && Number.isFinite(q.volume)
    ? Math.max(0, Math.round(q.volume) - (s.lastVol.get(symbol) ?? 0))
    : 0
  if (q.volume != null) s.lastVol.set(symbol, Math.round(q.volume))

  st2.ltp = ctx.r2(q.ltp)
  if (q.bid) st2.bid = ctx.r2(q.bid)
  if (q.ask) st2.ask = ctx.r2(q.ask)
  if (q.open) st2.open = ctx.r2(q.open)
  if (q.high) st2.high = ctx.r2(q.high)
  if (q.low) st2.low = ctx.r2(q.low)
  if (q.prevClose) st2.prevClose = ctx.r2(q.prevClose)
  if (q.high && q.low) { /* broker OHLC wins over per-tick high/low */ }
  else {
    st2.high = Math.max(st2.high, st2.ltp)
    st2.low = Math.min(st2.low, st2.ltp)
  }
  if (dv > 0) st2.vol += dv
  st2.lastTickDir = 1

  // 1m candle + higher-tf tail (same as the sim tick path)
  const key = `${symbol}|1m`
  const bars = ctx.S.candles.get(key)
  if (bars) {
    const bs = ctx.bucketStart(now, '1m')
    let cur = bars[bars.length - 1]
    if (!cur || cur.t !== bs) {
      cur = { t: bs, o: st2.ltp, h: st2.ltp, l: st2.ltp, c: st2.ltp, v: dv }
      bars.push(cur)
      for (const tf of Object.keys(TF_MS)) {
        if (tf === '1m') continue
        const sk = `${symbol}|${tf}`
        const series = ctx.S.candles.get(sk)
        if (series) {
          const b2 = ctx.bucketStart(now, tf)
          const last2 = series[series.length - 1]
          if (last2 && last2.t === b2) {
            last2.h = Math.max(last2.h, st2.ltp)
            last2.l = Math.min(last2.l, st2.ltp)
            last2.c = st2.ltp
            last2.v += dv
          } else series.push({ t: b2, o: st2.ltp, h: st2.ltp, l: st2.ltp, c: st2.ltp, v: dv })
        }
      }
    } else {
      cur.h = Math.max(cur.h, st2.ltp)
      cur.l = Math.min(cur.l, st2.ltp)
      cur.c = st2.ltp
      cur.v += dv
    }
  }
  s.liveFed.add(symbol)
  s.status.lastTickTs = now
  s.status.connected = true
  return true
}

// ---------- per-broker quote fetchers ----------
function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

// ---------- auth-failure handling (shared by all fetchers) ----------
/**
 * The broker rejected the CREDENTIALS (dead/expired session). Unlike a
 * network hiccup this needs user action: force a credential reload from the
 * DB every cycle (a freshly created Admin session is picked up within 1s),
 * surface the exact remedy, and back off so we never hammer the broker.
 */
function noteAuthFailure(broker: string, detail: string): void {
  const s = st()
  s.authFails++
  s.credsTs = 0
  s.status.lastError = `SESSION REJECTED by ${broker} (${detail}) — re-create it in Admin → Session (credentials re-read every cycle)`
  s.status.errorTs = Date.now()
  if (s.authFails >= 6) {
    s.backoffUntil = Date.now() + 30_000
    s.authFails = 0
    pushLog(`auth rejected repeatedly — pausing live polling for 30s (create a fresh session in Admin → Session)`, 'WARN')
  } else {
    pushLog(`${broker} rejected the session (${detail}) — reloading credentials from DB; if this repeats, re-create the session in Admin → Session`, 'WARN')
  }
}

function noteAuthOk(): void {
  const s = st()
  s.authFails = 0
  s.backoffUntil = 0
}

async function fetchDhan(accountId: string, creds: Record<string, string>, targets: MappingRow[]): Promise<void> {
  const s = st()
  const segments: Record<string, string[]> = {}
  for (const t of targets) {
    // Dhan segments (scrip-master parity): indices IDX_I, NSE eq NSE_EQ,
    // derivatives NSE_FNO/BSE_FNO, MCX MCX_COMM, currency NSE_CURRENCY
    const seg = t.instrumentType === 'INDEX' ? 'IDX_I'
      : t.exchange === 'NFO' ? 'NSE_FNO'
      : t.exchange === 'BFO' ? 'BSE_FNO'
      : t.exchange === 'BSE' ? 'BSE_EQ'
      : t.exchange === 'MCX' ? 'MCX_COMM'
      : t.exchange === 'CDS' ? 'NSE_CURRENCY'
      : 'NSE_EQ'
    const token = t.brokerToken || t.brokerSymbol
    if (!token) continue
    ;(segments[seg] ??= []).push(token)
  }
  if (Object.keys(segments).length === 0) return
  const started = Date.now()
  const res = await fetch('https://api.dhan.co/v2/marketfeed/quote', {
    method: 'POST',
    headers: {
      'access-token': creds.accessToken ?? '',
      ...(creds.clientId ? { 'client-id': creds.clientId } : {}),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(segments),
    signal: withTimeout(4000),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null) as { data?: Record<string, Record<string, Record<string, unknown>>>; errorMessage?: string } | null
  if (!res.ok) {
    s.status.errors++
    const msg = `Dhan quote HTTP ${res.status}${body?.errorMessage ? ` — ${body.errorMessage}` : ''}`
    if (res.status === 401 || res.status === 403 || /auth|token|access/i.test(body?.errorMessage ?? '')) {
      noteAuthFailure('Dhan', body?.errorMessage ?? `HTTP ${res.status}`)
    } else {
      s.status.lastError = msg
      s.status.errorTs = Date.now()
      pushLog(`dhan quote ${res.status} (${Date.now() - started}ms) — ${msg}`, 'WARN')
    }
    return
  }
  let n = 0
  for (const [, segData] of Object.entries(body?.data ?? {})) {
    for (const [token, q] of Object.entries(segData ?? {})) {
      const t = targets.find(t => (t.brokerToken || t.brokerSymbol) === token)
      if (!t) continue
      const ohlc = (q.ohlc ?? {}) as Record<string, unknown>
      const depth = (q.depth ?? {}) as { buy?: Record<string, unknown>[]; sell?: Record<string, unknown>[] }
      const num = (v: unknown): number | undefined => (Number.isFinite(Number(v)) ? Number(v) : undefined)
      if (applyQuote(t.masterSymbol, {
        ltp: num(q.last_price),
        bid: num(depth.buy?.[0]?.price),
        ask: num(depth.sell?.[0]?.price),
        open: num(ohlc.open), high: num(ohlc.high), low: num(ohlc.low), prevClose: num(ohlc.close),
        volume: num(q.volume),
      }, t)) n++
    }
  }
  s.status.polls++
  s.status.symbols = n
  if (n === 0) {
    s.status.lastError = 'Dhan quote responded but no symbol matched the mapping'
    s.status.errorTs = Date.now()
  }
}

async function fetchShoonya(accountId: string, creds: Record<string, string>, targets: MappingRow[]): Promise<void> {
  const s = st()
  const uid = creds.userId ?? ''
  const body = { uid, actid: uid, jKey: creds.sessionId ?? '' }
  const jdata = (b: Record<string, unknown>): string => 'jData=' + JSON.stringify(b).replace(/&/g, '\\u0026')
  let n = 0
  let lastErr: string | null = null
  let i = 0
  for (const t of targets) {
    // scrip-master sync stores brokerToken = "NSE|<tsym>"; older synthetic
    // rows keep the bare tsym in brokerSymbol
    const [exch, tsym] = (t.brokerToken || '').includes('|')
      ? (t.brokerToken || '').split('|')
      : (t.brokerSymbol || '').includes('|')
        ? (t.brokerSymbol || '').split('|')
        : [t.exchange === 'NFO' ? 'NFO' : t.exchange === 'BSE' ? 'BSE' : t.exchange === 'BFO' ? 'BFO' : t.exchange === 'MCX' ? 'MCX' : t.exchange === 'CDS' ? 'CDS' : 'NSE', t.brokerSymbol]
    if (!tsym) continue
    // Noren throttles per-second bursts — tiny sleep, round-robin subsets
    if (i > 0 && i % 6 === 0) await new Promise(r => setTimeout(r, 250))
    i++
    try {
      const res = await fetch('https://api.shoonya.com/NorenWClientTP/GetQuote', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: jdata({ ...body, exch, tsym }),
        signal: withTimeout(3000),
        cache: 'no-store',
      })
      const q = await res.json().catch(() => null) as Record<string, unknown> | { emsg?: string } | null
      if (!res.ok || !q || 'emsg' in q) {
        const emsg = (q as { emsg?: string })?.emsg ?? ''
        lastErr = `GetQuote ${res.status} ${emsg}`.trim()
        s.status.errors++
        if (/session|not authorized|invalid.*token|no session/i.test(emsg)) noteAuthFailure('Shoonya', emsg || `HTTP ${res.status}`)
        continue
      }
      const qr = q as Record<string, unknown>
      const num = (v: unknown): number | undefined => (Number.isFinite(Number(v)) ? Number(v) : undefined)
      if (applyQuote(t.masterSymbol, {
        ltp: num(qr.lp), bid: num(qr.bp1), ask: num(qr.sp1),
        open: num(qr.o), high: num(qr.h), low: num(qr.l), prevClose: num(qr.c),
        volume: num(qr.v) ?? num(qr.volume),
      }, t)) n++
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      s.status.errors++
    }
  }
  s.status.polls++
  s.status.symbols = n
  if (lastErr) { s.status.lastError = lastErr; s.status.errorTs = Date.now() }
  if (n === 0 && !lastErr) {
    s.status.lastError = 'Shoonya responded but no quote applied (mapping/session?)'
    s.status.errorTs = Date.now()
  }
}

async function fetchIcici(accountId: string, creds: Record<string, string>, targets: MappingRow[]): Promise<void> {
  const s = st()
  let n = 0
  let lastErr: string | null = null
  // Breeze rate limit ~3.5 req/s — round-robin batches of 3 symbols/cycle
  // (the full set covers over a few seconds), oldest-first rotation
  const BATCH = 3
  const rr = iciciRr % Math.max(1, targets.length)
  iciciRr = (iciciRr + 1) % Math.max(1, targets.length)
  const batch = targets.length <= BATCH ? targets : targets.slice(rr, rr + BATCH).concat(rr + BATCH > targets.length ? targets.slice(0, (rr + BATCH) % targets.length) : [])
  const bc: BreezeCreds = { apiKey: creds.apiKey, apiSecret: creds.apiSecret, sessionToken: creds.sessionToken, userId: creds.userId }
  const log = (line: string, level: 'INFO' | 'WARN' = 'INFO') => {
    if (level === 'WARN') pushLog(`breeze ${line}`, 'WARN')
  }
  for (const t of batch) {
    // brokerToken = "SYM|YYYY-MM-DD|strike|CE/PE" (breeze adapter mapSymbol)
    const [stock, expiry, strike, right] = (t.brokerToken || '').split('|')
    try {
      const res = await breezeRequest<Record<string, unknown>>(
        bc, 'GET', 'quotes',
        breezeInstrumentParams({
          symbol: stock || t.brokerSymbol,
          exchange: t.exchange,
          instrumentType: t.instrumentType,
          expiry: expiry || null,
          strike: strike || null,
          optionType: right || t.instrumentType,
        }),
        { timeoutMs: 5000, log },
      )
      const row = firstSuccess(res)
      if (res.status !== 200 || !row) {
        s.status.errors++
        // dead/expired session ("Unauthorized User" / "Invalid User Details" /
        // HTTP 401) — force a credential reload + back off, never hammer Breeze
        if (isAuthError(res)) {
          noteAuthFailure('ICICI Breeze', res.error ?? `HTTP ${res.httpStatus}`)
          lastErr = null // noteAuthFailure owns the status message — don't clobber it below
        } else {
          lastErr = `quotes ${res.httpStatus || res.status} ${res.error ?? ''}`.trim()
        }
        continue
      }
      const q = parseBreezeQuoteRow(row)
      if (applyQuote(t.masterSymbol, {
        ltp: q.ltp, bid: q.bid, ask: q.ask,
        open: q.open, high: q.high, low: q.low, prevClose: q.prevClose,
        volume: q.volume,
      }, t)) n++
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      s.status.errors++
    }
  }
  s.status.polls++
  s.status.symbols = n
  if (lastErr) { s.status.lastError = lastErr; s.status.errorTs = Date.now() }
  if (n === 0 && !lastErr) {
    s.status.lastError = 'Breeze responded but no quote applied (mapping/session?)'
    s.status.errorTs = Date.now()
  }
}

let iciciRr = 0

// ---------- main cycle ----------
async function cycle(): Promise<void> {
  const s = st()
  const ctx = s.ctx
  if (!ctx || s.inflight) return
  s.inflight = true
  try {
    // auth backoff — the broker rejected the session repeatedly; pause instead
    // of hammering (a fresh Admin session is picked up right after the pause)
    if (Date.now() < s.backoffUntil) {
      s.status.lastError = `auth rejected — backing off ${Math.ceil((s.backoffUntil - Date.now()) / 1000)}s (re-create the session in Admin → Session)`
      return
    }

    // active source + global sim switch (file is the shared source of truth)
    let source = 'sim'
    let simDisabled = false
    try {
      const raw = readFileSync(path.join(dbRoot(), 'feed-source.json'), 'utf8')
      const j = JSON.parse(raw) as { source?: string; simDisabled?: boolean }
      source = j.source ?? 'sim'
      simDisabled = j.simDisabled === true
    } catch { /* default sim */ }
    s.simDisabled = simDisabled

    if (source !== s.status.source) {
      // source changed — reset everything live AND purge the sim market data
      // so charts/depth never show simulated numbers under a real broker
      s.status.source = source
      s.status.brokerType = null
      s.status.connected = false
      s.status.lastTickTs = null
      s.status.lastError = null
      s.status.symbols = 0
      s.status.polls = 0
      s.status.errors = 0
      s.status.log = []
      s.liveFed.clear()
      s.lastVol.clear()
      s.mappings.clear()
      s.mappingsTs = 0
      s.creds = null
      s.credsTs = 0
      s.brokerType = ''
      s.accountId = ''
      if (ctx && source !== 'sim') {
        // purge sim market data when a LIVE broker becomes the source.
        // (reverting to 'sim' must NOT purge — the /feed-source handler
        // reseeds the universe right after this file write)
        ctx.S.states.clear()
        ctx.S.candles.clear()
      }
      if (source === 'sim') pushLog('feed source → sim (live polling idle)')
      else pushLog(`feed source → ${source} — market data PURGED (real broker data only, no sim fallback)`, 'WARN')
    }

    if (source === 'sim') {
      s.status.connected = false
      if (simDisabled) {
        s.status.lastError = 'SIM FEED DISABLED (Live-Only mode) — select a connected broker account as the feed source'
        s.status.errorTs = Date.now()
      }
      return
    }

    if (!s.accountId) {
      // resolve the account (type + label) once
      const master = openRO(path.join(dbRoot(), 'custom.db'))
      if (!master) { s.status.lastError = 'master DB not readable'; return }
      try {
        const acc = master.prepare('SELECT brokerType, label, isActive FROM BrokerAccount WHERE id = ?').get(source) as { brokerType: string; label: string; isActive: number } | undefined
        if (!acc) { s.status.lastError = `account ${source} not found`; s.status.errorTs = Date.now(); return }
        s.brokerType = acc.brokerType
        s.accountId = source
        s.status.brokerType = acc.brokerType
        pushLog(`live feed source → ${acc.label} (${acc.brokerType})`)
      } finally { master.close() }
    }

    // refresh creds + mappings periodically (credsTs=0 forces an immediate
    // reload — set by noteAuthFailure when the broker rejects the session)
    if (Date.now() - s.credsTs > 60_000) {
      const prevJson = s.creds ? JSON.stringify(s.creds) : ''
      s.creds = loadCreds(s.brokerType, s.accountId)
      s.credsTs = Date.now()
      const newJson = s.creds ? JSON.stringify(s.creds) : ''
      if (newJson !== prevJson) {
        if (!s.creds) pushLog(`no decrypted credentials for ${s.brokerType} — create the session in Admin`, 'WARN')
        else {
          const hasSession = !!(s.creds.sessionToken || s.creds.accessToken || s.creds.sessionId)
          pushLog(`credentials loaded (${s.brokerType}) — session ${hasSession ? 'present' : 'MISSING'}`, hasSession ? 'INFO' : 'WARN')
        }
      }
    }
    if (Date.now() - s.mappingsTs > 120_000) loadMappings(s.brokerType)
    if (!s.creds) { s.status.lastError = 'no broker session credentials — create the session in Admin → Session dialog'; s.status.errorTs = Date.now(); return }

    // targets = subscribed symbols + tick-recorder symbols, mapped to this broker
    const wanted = new Set<string>([...ctx.subscribed(), ...ctx.getTickCfg().symbols])
    const targets: MappingRow[] = []
    for (const sym of wanted) {
      const m = s.mappings.get(sym)
      if (m && (m.brokerSymbol || m.brokerToken)) targets.push(m)
    }
    // no subscribers → keep the recorder set at least
    if (targets.length === 0) { s.status.connected = false; return }

    const creds = s.creds
    const hasSession = !!(creds.sessionToken || creds.accessToken || creds.sessionId)
    if (!hasSession) {
      s.status.lastError = 'broker session token missing — open Admin → Session and create it'
      s.status.errorTs = Date.now()
      return
    }

    if (s.brokerType === 'DHAN') await fetchDhan(s.accountId, creds, targets)
    else if (s.brokerType === 'SHOONYA') await fetchShoonya(s.accountId, creds, targets)
    else if (s.brokerType === 'ICICI_BREEZE') await fetchIcici(s.accountId, creds, targets)
    else { s.status.lastError = `broker ${s.brokerType} has no live feed adapter`; s.status.errorTs = Date.now() }
    // any applied quote clears the auth-failure state
    if (s.status.symbols > 0) noteAuthOk()
  } catch (e) {
    s.status.errors++
    s.status.lastError = e instanceof Error ? e.message : String(e)
    s.status.errorTs = Date.now()
    pushLog(`cycle error: ${s.status.lastError}`, 'WARN')
  } finally {
    s.inflight = false
  }
}

export function ensureLiveFeed(ctx: LiveFeedCtx): void {
  const s = st()
  s.ctx = ctx
  if (s.timer) return
  s.timer = setInterval(() => { void cycle() }, 1000)
  pushLog('live broker feed engine started (1s cycles)')
}

export function liveFedSymbols(): Set<string> {
  return st().liveFed
}

export function liveFeedStatus(): FeedStatus & { sessionPresent: boolean } {
  const s = st()
  return {
    ...s.status,
    sessionPresent: !!(s.creds && (s.creds.sessionToken || s.creds.accessToken || s.creds.sessionId)),
  }
}
