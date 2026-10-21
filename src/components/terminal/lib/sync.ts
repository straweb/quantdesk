'use client'

import { useEffect, useRef, useState } from 'react'
import { ensureSocket } from './socket'
import type { ChainMeta, ChainStrikeRow, OptionQuoteCell } from '../lib/client-api'

// ============================================================
// Realtime sync — ONE websocket subscription replaces the N
// polling API calls (accounts / positions / orders / trades /
// funds / session stats / option chain / index constituents).
// The market-feed service computes these from direct read-only
// SQLite reads and pushes them over the existing feed socket,
// so there is no Next.js HTTP hop in the data path.
//
// Components use useSyncChannel(channel); params (chain /
// index subscriptions) are diffed and re-emitted on change.
// ============================================================

export interface SyncSubParams {
  chains?: { underlying: string; expiry?: string | null }[]
  index?: string[]
}

type SyncHandler = (data: unknown) => void

const g = globalThis as unknown as {
  __syncHandlers: Map<string, Set<SyncHandler>>
  __syncSubs: SyncSubParams
}
if (!g.__syncHandlers) g.__syncHandlers = new Map()
if (!g.__syncSubs) g.__syncSubs = {}

function emitLocal(channel: string, data: unknown) {
  const set = g.__syncHandlers.get(channel)
  if (set) for (const fn of set) fn(data)
}

function emitSub() {
  const socket = ensureSocket()
  socket.emit('sync:sub', {
    chains: g.__syncSubs.chains ?? [],
    index: g.__syncSubs.index ?? [],
  })
}

// re-emit the subscription after every (re)connect + bridge socket events
// into the local channel listeners
let subWireInstalled = false
const SYNC_CHANNELS = ['sync:core', 'sync:chain', 'sync:index'] as const
function ensureSubWire() {
  if (subWireInstalled) return
  subWireInstalled = true
  const socket = ensureSocket()
  for (const ch of SYNC_CHANNELS) {
    socket.on(ch, d => emitLocal(ch, d))
  }
  socket.on('connect', () => emitSub())
}

/** Register per-socket sync parameters (chains / index lists). */
export function syncSubscribe(params: SyncSubParams) {
  g.__syncSubs = params
  ensureSubWire()
  emitSub()
}

/** Attach a listener to a sync channel. Returns an unsubscribe fn. */
export function onSync<T>(channel: string, fn: (data: T) => void): () => void {
  ensureSubWire() // make sure socket events are bridged into listeners
  const wrapped = fn as SyncHandler
  if (!g.__syncHandlers.has(channel)) g.__syncHandlers.set(channel, new Set())
  g.__syncHandlers.get(channel)!.add(wrapped)
  return () => { g.__syncHandlers.get(channel)?.delete(wrapped) }
}

/** React hook: subscribe to a sync channel (always-on). */
export function useSyncChannel<T>(channel: string): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    ensureSocket()
    return onSync<T>(channel, setData)
  }, [channel])
  return data
}

/** React hook: subscribe to a sync channel whose payload only arrives
 *  when the given params are subscribed. Merges all chain/index params
 *  from every consumer of the hook set — each hook instance only keeps
 *  its own payload slice. */
export function useSyncData<T>(
  channel: 'sync:core' | 'sync:chain' | 'sync:index',
  match?: (data: T) => boolean,
  params?: SyncSubParams,
): T | null {
  const [data, setData] = useState<T | null>(null)
  const matchRef = useRef(match)
  matchRef.current = match
  const paramsKey = JSON.stringify(params ?? {})
  useEffect(() => {
    ensureSocket()
    if (params) {
      // merge params: chains/index union across all users
      const cur = g.__syncSubs
      const chains = [...(cur.chains ?? [])]
      for (const c of params.chains ?? []) {
        if (!chains.some(x => x.underlying === c.underlying && (x.expiry ?? null) === (c.expiry ?? null))) chains.push({ underlying: c.underlying, expiry: c.expiry ?? null })
      }
      const index = [...(cur.index ?? [])]
      for (const i of params.index ?? []) if (!index.includes(i)) index.push(i)
      syncSubscribe({ chains, index })
    }
    return onSync<T>(channel, d => {
      if (!matchRef.current || matchRef.current(d)) setData(d)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, paramsKey])
  return data
}

/** Global sync:core payload shape (mirrors the REST aggregates). */
export interface SyncCore {
  accounts: {
    id: string; label: string; brokerType: string; status: string
    isActive: boolean; isLiveDataSource: boolean; isOrderEnabled: boolean; isCopyMaster: boolean
    clientId: string | null; usableCapital: number; initialCapital: number; realizedPnl: number
    chargesPaid: number; deployed: number; mode: string; modeLabel: string
    firstTradeDone: boolean; openPositions: number; openOrders: number
  }[]
  positions: {
    accountId: string; accountLabel: string; brokerType: string
    symbol: string; exchange: string; productType: string
    netQty: number; buyQty: number; sellQty: number
    avgPrice: number; realizedPnl: number; ltp: number; unrealizedPnl: number
    lotSize: number; updatedAt: string
  }[]
  orders: {
    id: string; masterOrderId?: string; symbol: string; exchange: string
    side: 'BUY' | 'SELL'; qty: number; filledQty: number; orderType: string
    productType: string; status: string; avgPrice?: number; message?: string
    createdAt: string; updatedAt: string
    accountId: string; accountLabel: string; brokerType: string
  }[]
  trades: {
    id: string; orderId: string; symbol: string; exchange: string; side: 'BUY' | 'SELL'
    qty: number; price: number; value: number; chargesTotal: number
    charges: { brokerage: number; stt: number; transaction: number; gst: number; sebi: number; stamp: number; total: number } | null
    realizedPnl?: number; ts: string
    accountId: string; accountLabel: string; brokerType: string
  }[]
  funds: {
    accountId: string; label: string; brokerType: string
    cash: number; initialCapital: number; realizedPnl: number; chargesPaid: number; deployed: number
  }[]
  session: {
    winRate: number | null; pts: number; realized: number; unrealized: number; net: number
    closes: number; wins: number; trades: number; charges: number
    perAccount: { accountId: string; label: string; brokerType: string; trades: number; closes: number; wins: number; pts: number; realized: number; unrealized: number; charges: number }[]
    topSymbols: { symbol: string; pts: number }[]
  }
  sessionStart: string
  ts: number
}

// ---- option chain over the sync hub ----

export interface SyncChainResp {
  meta: ChainMeta
  rows: ChainStrikeRow[]
  atmCe: (OptionQuoteCell & { strike: number }) | null
  atmPe: (OptionQuoteCell & { strike: number }) | null
  ts: number
}

/** Structural shape both the hub payload and the REST chain response fit. */
type ChainRespLike = {
  meta: ChainMeta
  rows: ChainStrikeRow[]
  atmCe?: (OptionQuoteCell & { strike: number }) | null
  atmPe?: (OptionQuoteCell & { strike: number }) | null
  ts?: number
}

/** Merge the realtime chain payload with a REST fetch: the socket copy
 *  wins per strike, REST rows fill strikes outside the hub's ±15-step
 *  band (user-added far strikes still get quotes). */
export function mergeChain(sync: ChainRespLike | null | undefined, rest: ChainRespLike | null | undefined): SyncChainResp | null {
  if (!sync) return rest ? { meta: rest.meta, rows: rest.rows, atmCe: rest.atmCe ?? null, atmPe: rest.atmPe ?? null, ts: rest.ts ?? 0 } : null
  if (!rest) return { meta: sync.meta, rows: sync.rows, atmCe: sync.atmCe ?? null, atmPe: sync.atmPe ?? null, ts: sync.ts ?? 0 }
  const map = new Map<number, ChainStrikeRow>()
  for (const r of rest.rows) map.set(r.strike, r)
  for (const r of sync.rows) map.set(r.strike, r)
  return {
    meta: sync.meta,
    rows: [...map.values()].sort((a, b) => a.strike - b.strike),
    atmCe: sync.atmCe ?? rest.atmCe ?? null,
    atmPe: sync.atmPe ?? rest.atmPe ?? null,
    ts: sync.ts ?? 0,
  }
}
