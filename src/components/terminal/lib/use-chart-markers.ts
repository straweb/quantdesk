'use client'

import { useMemo } from 'react'
import { toast } from 'sonner'
import { useTerminal } from './store'
import { useSyncChannel, type SyncCore } from './sync'
import { api, fmtMoney } from './client-api'
import type { ChartMarker } from '../chart/canvas-chart'

// ============================================================
// Shared chart-marker plumbing:
//  · entry markers from OPEN positions (@ avg price + PnL + %)
//  · draggable SL / target level markers (persisted per symbol)
// On drop: the level persists AND — when a position exists — a
// real reduce-only resting order is armed at the dropped price
// (SL-M for the SL line, LIMIT for the target line).
// ============================================================

export function useChartCore(): SyncCore | null {
  return useSyncChannel<SyncCore>('sync:core')
}

export function useChartMarkers(symbol: string, core: SyncCore | null, lotSize = 1): ChartMarker[] {
  const levels = useTerminal(s => s.chartLevels[symbol])
  return useMemo(() => {
    const out: ChartMarker[] = []
    const rows = (core?.positions ?? []).filter(p => p.symbol === symbol && p.netQty !== 0 && p.avgPrice > 0)
    const pos = rows[0]
    for (const p of rows) {
      const pnl = p.unrealizedPnl
      const pct = p.avgPrice ? (pnl / Math.abs(p.avgPrice * p.netQty)) * 100 : 0
      out.push({
        id: `pos-${p.accountId}`,
        kind: 'entry',
        price: p.avgPrice,
        label: p.netQty > 0 ? 'L' : 'S',
        color: p.netQty > 0 ? '#00c896' : '#ff4d5e',
        sub: `${pnl >= 0 ? '+' : ''}${fmtMoney(pnl, 0)} · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
      })
    }
    const long = pos ? pos.netQty > 0 : true
    if (levels?.sl && levels.sl > 0) {
      out.push({ id: 'lvl-sl', kind: 'sl', price: levels.sl, label: 'SL', color: '#ff4d5e' })
    } else if (pos) {
      // suggested stop — drag it to the level you want (drop arms a real SL-M)
      out.push({ id: 'lvl-sl', kind: 'sl', price: Number((pos.avgPrice * (long ? 0.98 : 1.02)).toFixed(2)), label: 'SL', color: '#ff4d5e', sub: 'drag to set' })
    }
    if (levels?.target && levels.target > 0) {
      out.push({ id: 'lvl-tgt', kind: 'target', price: levels.target, label: 'TGT', color: '#00c896' })
    } else if (pos) {
      // suggested target — drag it anywhere (drop arms a real reduce-only LIMIT)
      out.push({ id: 'lvl-tgt', kind: 'target', price: Number((pos.avgPrice * (long ? 1.04 : 0.96)).toFixed(2)), label: 'TGT', color: '#00c896', sub: 'drag to set' })
    }
    void lotSize
    return out
  }, [core, symbol, levels, lotSize])
}

/** Drop a draggable level marker: persist + arm a real resting order when flat-not. */
export async function commitChartLevel(symbol: string, kind: 'sl' | 'target', price: number, core: SyncCore | null): Promise<void> {
  useTerminal.getState().setChartLevel(symbol, kind, price)
  const pos = (core?.positions ?? []).find(p => p.symbol === symbol && p.netQty !== 0)
  if (!pos) {
    toast.info(`${kind === 'sl' ? 'SL' : 'Target'} level set @ ${fmtMoney(price)} — drag again anytime (arm an order from the strike editor)`)
    return
  }
  const side = pos.netQty > 0 ? 'SELL' : 'BUY'
  const lots = Math.abs(pos.netQty) / (pos.lotSize || 1)
  try {
    const res = await api.placeOrder(
      kind === 'sl'
        ? { symbol, exchange: 'NFO', side, qty: lots, orderType: 'SL-M', productType: 'MIS', source: 'MANUAL', triggerPrice: price, reduceOnly: true, strategyId: 'reduce' }
        : { symbol, exchange: 'NFO', side, qty: lots, orderType: 'LIMIT', productType: 'MIS', source: 'MANUAL', limitPrice: price, reduceOnly: true, strategyId: 'reduce' },
    )
    const f = res.legs.filter(l => l.status === 'FILLED').length
    const r = res.legs.filter(l => l.status === 'OPEN').length
    if (f + r === 0) toast.error(`${kind === 'sl' ? 'SL' : 'Target'} order failed — ${res.message}`)
    else toast.success(`${kind === 'sl' ? 'Stop-loss' : 'Target'} armed @ ${fmtMoney(price)} — ${lots} lot(s) reduce-only${r ? ` · ${r} resting` : ''}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Level order failed')
  }
}
