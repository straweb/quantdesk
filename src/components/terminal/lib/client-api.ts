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

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data as T
}

export const api = {
  login: (username: string, password: string) =>
    fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }).then(r => j<{ ok: boolean }>(r)),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }),
  me: () => fetch('/api/auth/me').then(r => j<{ user: string | null; feed: string }>(r)),

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
  syncSymbols: () => fetch('/api/symbols/sync', { method: 'POST' }).then(r => j<{ ok: boolean; symbolCount: number; mappedCount: number }>(r)),
  syncInfo: () => fetch('/api/symbols/sync').then(r => j<{ lastSync: string | null; counts: { symbols: number; mappings: number } }>(r)),

  placeOrder: (body: Record<string, unknown>) =>
    fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<MasterOrderResult>(r)),
  squareOffAll: (kill = false) =>
    fetch('/api/orders/squareoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ killSwitch: kill }) }).then(r => j<{ ok: boolean; orders: number; filledLegs: number }>(r)),
  cancelAll: () => fetch('/api/orders/cancel-all', { method: 'POST' }).then(r => j<{ ok: boolean; cancelled: number }>(r)),
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
    fetch(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`).then(r => j<{ symbol: string; ltp: number; prevClose: number; bid: number; ask: number; depth: { buys: { price: number; qty: number }[]; sells: { price: number; qty: number }[] } }>(r)),
  status: () => fetch('/api/market/status').then(r => j<{ services: Record<string, string | number>; masterContracts: { count: number; lastSync: string | null }; accounts: number; enabledStrategies: number }>(r)),
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
