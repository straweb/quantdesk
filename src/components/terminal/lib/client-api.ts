'use client'

import type {
  AccountSnapshot, Candle, MasterOrderResult, OrderLegResult, PositionRecord, Timeframe, Tick,
} from '@/lib/types'

export interface AccountRow extends AccountSnapshot {
  clientId: string | null
  modeLabel: string | null
}

export interface AggPosition extends PositionRecord {
  accountId: string
  accountLabel: string
  brokerType: string
  instrumentType?: string
}

export interface AggOrder {
  id: string
  masterOrderId?: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  filledQty: number
  orderType: string
  productType: string
  status: string
  avgPrice?: number
  message?: string
  createdAt: string
  updatedAt: string
  accountId: string
  accountLabel: string
  brokerType: string
}

export interface AggTrade {
  id: string
  orderId: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  value: number
  chargesTotal: number
  charges: { brokerage: number; stt: number; transaction: number; gst: number; sebi: number; stamp: number; total: number }
  realizedPnl?: number
  ts: string
  accountId: string
  accountLabel: string
  brokerType: string
}

export interface FundRow {
  accountId: string
  label: string
  brokerType: string
  cash: number
  initialCapital: number
  realizedPnl: number
  chargesPaid: number
  deployed: number
}

export interface SymbolRow {
  id: string
  symbol: string
  name: string
  exchange: string
  instrumentType: string
  expiry?: string | null
  strike?: number | null
  optionType?: string | null
  lotSize: number
  basePrice?: number | null
  mappings: { brokerType: string; brokerSymbol: string; brokerToken: string | null }[]
}

export interface StrategyRow {
  id: string
  name: string
  enabled: boolean
  status: string
  exchange: string
  symbol: string
  direction: string
  productType: string
  orderType: string
  qtyMode: string
  fixedQty: number
  capitalAmount?: number | null
  entryTime: string
  entryWindowMin: number
  exitTime: string
  repeatDays: string
  stopLossPct?: number | null
  targetPct?: number | null
  trailingSlPct?: number | null
  lastRunDate?: string | null
  entryPrice?: number | null
  realizedPnl: number
  logs: { id: string; ts: string; level: string; message: string }[]
}

export interface CopyTradeCfg {
  id: string
  enabled: boolean
  masterAccountId: string | null
  capitalSharePct: number
  slippagePct: number
  roundToLot: boolean
  skipFailedLegs: boolean
  killSwitch: boolean
}

// ---- options chain ----
export interface OptionUnderlyingRow {
  underlying: string
  name: string
  lotSize: number
  expiries: string[]
  instrumentType: string
}

export interface ChainMeta {
  underlying: string
  exchange: string
  spot: number
  prevClose: number
  atm: number
  ceAtm: number // CE-side ATM = floor(spot/step)*step
  peAtm: number // PE-side ATM = ceil(spot/step)*step
  step: number
  lotSize: number
  expiry: string
  expiries: string[]
  strikesAvailable: number[]
}

export interface OptionQuoteCell {
  symbol: string
  exists: boolean
  ltp: number
  prevClose: number
  high: number
  low: number
  changePct: number
}

export interface ChainStrikeRow {
  strike: number
  offset: number
  offsetCe: number // steps vs CE-side ATM
  offsetPe: number // steps vs PE-side ATM
  ce: OptionQuoteCell
  pe: OptionQuoteCell
}

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const apiErr = (data as { error?: string }).error
    // Gateway/proxy error pages return HTML (not JSON) — surface a readable message
    if (!apiErr && res.status >= 502) throw new Error(`Server unreachable (HTTP ${res.status}) — try again in a few seconds`)
    throw new Error(apiErr || `HTTP ${res.status}`)
  }
  return data as T
}

async function fetchJson<T>(input: string, init?: RequestInit, retries = 1): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await j<T>(await fetch(input, { cache: 'no-store', ...init }))
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : ''
      const transient = /Server unreachable|HTTP 5|Failed to fetch|NetworkError|Load failed/i.test(msg)
      if (!transient || attempt === retries) break
      await new Promise(r => setTimeout(r, 800))
    }
  }
  throw lastErr
}

export const api = {
  login: (username: string, password: string) =>
    fetchJson<{ ok: boolean }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }, 1),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }),
  me: () => fetchJson<{ user: string | null; feed: string }>('/api/auth/me'),

  feedSource: () =>
    fetchJson<{ source: string; sources: { id: string; label: string; brokerType: string | null }[] }>('/api/feed'),
  setFeedSource: (source: string) =>
    fetch('/api/feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) }).then(r => j<{ ok: boolean; source: string }>(r)),

  accounts: () => fetch('/api/accounts').then(r => j<{ accounts: AccountRow[] }>(r)),
  createAccount: (body: Record<string, unknown>) =>
    fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ ok: boolean; id: string }>(r)),
  patchAccount: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/accounts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ ok: boolean }>(r)),
  deleteAccount: (id: string) => fetch(`/api/accounts/${id}`, { method: 'DELETE' }).then(r => j<{ ok: boolean }>(r)),

  copyTrade: () => fetch('/api/copytrade').then(r => j<{ config: CopyTradeCfg }>(r)),
  patchCopyTrade: (body: Record<string, unknown>) =>
    fetch('/api/copytrade', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ config: CopyTradeCfg }>(r)),

  symbols: (q: string, type: string) =>
    fetch(`/api/symbols?q=${encodeURIComponent(q)}&type=${type}&limit=120`).then(r => j<{ symbols: SymbolRow[] }>(r)),
  symbolsByList: (list: string[]) =>
    fetch(`/api/symbols?symbols=${encodeURIComponent(list.join(','))}&limit=200`).then(r => j<{ symbols: SymbolRow[] }>(r)),
  syncSymbols: () => fetch('/api/symbols/sync', { method: 'POST' }).then(r => j<{ ok: boolean; symbolCount: number; mappedCount: number }>(r)),
  syncInfo: () => fetch('/api/symbols/sync').then(r => j<{ lastSync: string | null; counts: { symbols: number; mappings: number } }>(r)),

  placeOrder: (body: Record<string, unknown>) =>
    fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<MasterOrderResult>(r)),
  squareOffAll: (kill = false, symbols?: string[]) =>
    fetch('/api/orders/squareoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ killSwitch: kill, symbols }) }).then(r => j<{ ok: boolean; orders: number; filledLegs: number }>(r)),
  cancelAll: (symbols?: string[]) =>
    fetch('/api/orders/cancel-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols }) }).then(r => j<{ ok: boolean; cancelled: number }>(r)),
  orders: () => fetch('/api/orders').then(r => j<{ orders: AggOrder[] }>(r)),
  positions: () => fetch('/api/positions').then(r => j<{ positions: AggPosition[]; bySymbol: { symbol: string; netQty: number; avgPrice: number; ltp: number; unrealizedPnl: number; accounts: number }[]; totals: { unrealizedPnl: number; realizedPnl: number; openPositions: number } }>(r)),
  trades: () => fetch('/api/trades').then(r => j<{ trades: AggTrade[]; totals: { charges: number; realized: number } }>(r)),
  funds: () => fetch('/api/funds').then(r => j<{ funds: FundRow[] }>(r)),
  brokerLogs: (accountId: string) => fetch(`/api/broker-logs?accountId=${accountId}`).then(r => j<{ logs: { id: number; ts: string; level: string; message: string }[] }>(r)),
  audit: () => fetch('/api/admin/audit').then(r => j<{ audits: { id: string; ts: string; source: string; action: string; masterSymbol: string; side: string; qty: number; status: string; message: string | null; legsJson: string | null }[] }>(r)),

  strategies: () => fetch('/api/strategies').then(r => j<{ strategies: StrategyRow[] }>(r)),
  createStrategy: (body: Record<string, unknown>) =>
    fetch('/api/strategies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ ok: boolean }>(r)),
  patchStrategy: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/strategies/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ ok: boolean }>(r)),
  deleteStrategy: (id: string) => fetch(`/api/strategies/${id}`, { method: 'DELETE' }).then(r => j<{ ok: boolean }>(r)),
  strategyPython: (id: string) => fetch(`/api/strategies/${id}/python`).then(r => j<{ code: string; filename: string | null }>(r)),

  candles: (symbol: string, tf: Timeframe, limit = 500) =>
    fetch(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`).then(r => j<{ candles: Candle[] }>(r)),
  quote: (symbol: string) =>
    fetch(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`).then(r => j<{ symbol: string; ltp: number; prevClose: number; bid: number; ask: number; lotSize?: number; instrumentType?: string | null; depth: { buys: { price: number; qty: number }[]; sells: { price: number; qty: number }[] } }>(r)),
  indexComponents: (symbol: string) =>
    fetch(`/api/market/index?symbol=${encodeURIComponent(symbol)}`).then(r => j<IndexComponentsResp>(r)),
  sessionStats: () => fetch('/api/stats/session').then(r => j<SessionStatsResp>(r)),
  tickRecorder: () => fetch('/api/tickrecorder').then(r => j<TickRecorderResp>(r)),
  setTickRecorder: (body: { enabled?: boolean; symbols?: string[] }) =>
    fetch('/api/tickrecorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ ok: boolean; enabled: boolean; symbols: string[] }>(r)),
  cancelOrder: (accountId: string, orderId: string) =>
    fetch('/api/orders/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, orderId }) }).then(r => j<{ ok: boolean }>(r)),
  status: () => fetch('/api/market/status').then(r => j<{ services: Record<string, string | number>; masterContracts: { count: number; lastSync: string | null }; accounts: number; enabledStrategies: number }>(r)),

  // ---- FNO universe (all exchanges: NFO / BFO / BFNO / MCX / CDS) ----
  fnoUniverse: () =>
    fetch('/api/market/fno').then(r => j<FnoUniverseResp>(r)),

  // ---- paper-trading replay (admin) ----
  replayStatus: () =>
    fetch('/api/replay').then(r => j<ReplayStatusResp>(r)),
  replayControl: (body: { mode: 'start' | 'stop'; file?: string | null; random?: boolean; fromTs?: number | null; toTs?: number | null; speed?: number }) =>
    fetch('/api/replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<ReplayStatusResp>(r)),

  // ---- python strategy runner (backend tool) ----
  runPython: (body: { id?: string; code?: string; symbol?: string; tf?: string; bars?: number; dryRun?: boolean }) =>
    fetch('/api/strategy/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<PythonRunResp>(r)),

  // ---- options chain (strikes panel) ----
  optionUnderlyings: () =>
    fetch('/api/options/underlyings').then(r => j<{ underlyings: OptionUnderlyingRow[] }>(r)),
  optionChain: (underlying: string, expiry: string | null, strikes: number[]) =>
    fetch(`/api/options/chain?underlying=${encodeURIComponent(underlying)}&expiry=${expiry ? encodeURIComponent(expiry) : ''}&strikes=${strikes.join(',')}`)
      .then(r => j<{ meta: ChainMeta; rows: ChainStrikeRow[]; atmRow: ChainStrikeRow | null; atmCe: (OptionQuoteCell & { strike: number }) | null; atmPe: (OptionQuoteCell & { strike: number }) | null }>(r)),
  ensureStrike: (underlying: string, strike: number, expiry: string | null) =>
    fetch('/api/options/ensure-strike', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ underlying, strike, expiry }) })
      .then(r => j<{ ok: boolean; created: number; symbols: string[] }>(r)),

  // ---- auto rules (index-based / time-based CE-PE entries) ----
  autoRules: () => fetch('/api/autorules').then(r => j<{ rules: AutoRuleRow[] }>(r)),
  createAutoRule: (body: Record<string, unknown>) =>
    fetch('/api/autorules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ ok: boolean; rule: AutoRuleRow }>(r)),
  patchAutoRule: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/autorules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ ok: boolean }>(r)),
  deleteAutoRule: (id: string) => fetch(`/api/autorules/${id}`, { method: 'DELETE' }).then(r => j<{ ok: boolean }>(r)),

  // ---- live broker API access (order book of a real broker account) ----
  brokerOrderBook: (accountId: string) =>
    fetch(`/api/broker-orderbook?accountId=${encodeURIComponent(accountId)}`).then(r => j<{ orders: BrokerBookRow[]; live: boolean; message?: string }>(r)),

  // ---- portfolio / GTT / margin (dashboard) ----
  portfolio: () => fetch('/api/portfolio').then(r => j<PortfolioResp>(r)),
  gttRules: () => fetch('/api/gtt').then(r => j<{ rules: GttRuleRow[] }>(r)),
  createGtt: (body: Record<string, unknown>) =>
    fetch('/api/gtt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ ok: boolean; rule: GttRuleRow }>(r)),
  patchGtt: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/gtt/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<{ ok: boolean; rule: GttRuleRow }>(r)),
  deleteGtt: (id: string) => fetch(`/api/gtt/${id}`, { method: 'DELETE' }).then(r => j<{ ok: boolean }>(r)),
  marginCalc: (body: { accountId: string; symbol: string; side: string; qty: number; price: number; productType?: string }) =>
    fetch('/api/margin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<MarginResp>(r)),
}

// ---- dashboard types ----

export interface PortfolioHolding {
  symbol: string
  qty: number
  avgPrice: number
  ltp: number
  pnl: number
  value: number
}

export interface PortfolioAccount {
  accountId: string
  accountLabel: string
  brokerType: string
  live: boolean
  holdings: PortfolioHolding[]
  message?: string
}

export interface PortfolioResp {
  portfolio: PortfolioAccount[]
  positions: { accountId: string; accountLabel: string; symbol: string; netQty: number; avgPrice: number; ltp: number; lotSize: number }[]
  ts: string
}

export interface GttRuleRow {
  id: string
  name: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  trigger: 'ABOVE' | 'BELOW'
  triggerPrice: number
  orderType: 'LIMIT' | 'MARKET'
  productType: string
  repeatDaily: boolean
  armed: boolean
  lastTriggeredAt?: string
  lastStatus?: string
  lastMessage?: string
  createdAt: string
}

export interface MarginResp {
  estimate?: { required: number; available?: number; span?: number; exposure?: number; leverage?: number; detail?: string } | null
  usable?: number
  live?: boolean
  error?: string
}

export interface AutoRuleRow {
  id: string
  name: string
  underlying: string
  expiry: string | null
  kind: 'INDEX' | 'INDEX_RANGE' | 'TIME' | 'COMPOUND'
  level?: number
  cross?: 'ABOVE' | 'BELOW'
  lo?: number
  hi?: number
  time?: string
  entryOp?: 'LTE' | 'GTE' | 'RANGE'
  entryLo?: number
  entryHi?: number
  action: 'BUY' | 'SELL' | 'DEPLOY' | 'CANCEL'
  optType: 'CE' | 'PE'
  offset: number
  strikes?: { strike: number; type: 'CE' | 'PE'; allocPct: number }[]
  allocPct: number
  entryPrice?: number
  stopLoss?: number
  target?: number
  enabled: boolean
  repeatDaily: boolean
  lastFiredDate?: string
  lastFiredAt?: string
  lastStatus?: string
  lastMessage?: string
  fireCount: number
  createdAt: string
}

export interface IndexComponentRow {
  symbol: string
  weight: number
  ltp: number
  high: number
  low: number
  vol: number
  chgPct: number
  pts: number
}

export interface IndexComponentsResp {
  index: { symbol: string; name: string; ltp: number; prevClose: number; high: number; low: number; vol: number; chgPts: number; chgPct: number }
  constituents: IndexComponentRow[]
  totalPts: number
}

export interface SessionStatsResp {
  winRate: number | null
  pts: number
  realized: number
  unrealized: number
  net: number
  closes: number
  wins: number
  trades: number
  charges: number
  perAccount: { accountId: string; label: string; brokerType: string; trades: number; closes: number; wins: number; pts: number; realized: number; unrealized: number; charges: number }[]
  topSymbols: { symbol: string; pts: number }[]
}

export interface TickRecorderResp {
  enabled: boolean
  symbols: string[]
  session: { file: string; startedAt: string; rows: number } | null
  sessions: { file: string; bytes: number; mtime: string }[]
}

export interface FnoUnderlyingRow {
  underlying: string
  name: string
  exchange: string // NFO | BFO | BFNO | MCX | CDS
  segment: string // IDX | EQ | COMM | CUR
  instrumentType: string
  lotSize: number
  latestExpiry: string | null
  contracts: number // option contracts for the latest expiry
  spot: number
  chgPct: number
}

export interface FnoUniverseResp {
  groups: { exchange: string; label: string; underlyings: FnoUnderlyingRow[] }[]
}

export interface ReplayStatusResp {
  active: boolean
  file: string | null
  random?: boolean
  speed: number
  startedAt: string | null
  total: number
  played: number
  symbols: string[]
  fromTs?: number | null
  toTs?: number | null
  progressPct: number
}

export interface PythonRunResp {
  ok: boolean
  runId: string
  logs: string[]
  signals: { ts: string; symbol: string; side: string; qty?: number; price?: number; message?: string }[]
  ordersPlaced: number
  error?: string
  ms: number
}

export interface BrokerBookRow {
  brokerOrderId: string
  symbol: string
  side: string
  qty: number
  filledQty?: number
  status: string
  avgPrice?: number
  orderType?: string
  ts?: string
}

// ---- ITM / OTM / ATM strike labeling (hedge-desk convention) ----
// Side-ATM: CE ATM = floor(spot/step)*step, PE ATM = ceil(spot/step)*step.
// Spot 23030 (step 50): CE ATM 23000 · CE ITM1 22950 · CE OTM1 23050;
//                       PE ATM 23050 · PE ITM1 23100 · PE OTM1 23000.
// offset = steps vs the SIDE's ATM (offsetCe for CE, offsetPe for PE):
//   CE: negative offset = strike below side-ATM = ITM, positive = OTM
//   PE: positive offset = strike above side-ATM = ITM, negative = OTM
export function sideOffsetLabel(offset: number | null | undefined, type: 'CE' | 'PE'): string {
  if (offset == null || !Number.isFinite(offset)) return ''
  if (offset === 0) return 'ATM'
  const itm = type === 'CE' ? offset < 0 : offset > 0
  return `${itm ? 'ITM' : 'OTM'} ${Math.abs(offset)}`
}

/** Side-specific strike for a labeled distance from ATM: dir = -1 (ITM) | 0 (ATM) | +1 (OTM). */
export function sideStrikeFor(atm: { ce: number; pe: number }, step: number, dir: -1 | 0 | 1, n: number, type: 'CE' | 'PE'): number {
  const base = type === 'CE' ? atm.ce : atm.pe
  // CE: ITM = below ceAtm, OTM = above; PE mirrored (ITM = above peAtm)
  const signed = type === 'CE' ? dir : -dir
  return base + signed * n * step
}

export function fmtMoney(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export function fmtInr(n: number | null | undefined, dp = 0): string {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export function fmtTime(ts: string | number | Date): string {
  return new Date(ts).toLocaleTimeString('en-IN', { hour12: false })
}

export function fmtDateTime(ts: string | number | Date): string {
  return new Date(ts).toLocaleString('en-IN', { hour12: false, dateStyle: 'short', timeStyle: 'medium' })
}
