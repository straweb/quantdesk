'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Timeframe, OrderSide, OrderTypeKind, ProductType } from '@/lib/types'

export type AppView = 'terminal' | 'admin' | 'strategy'

export interface StrikeRowCfg {
  id: string // `${strike}:${type}`
  strike: number
  type: 'CE' | 'PE'
  enabled: boolean
  allocPct: number // % of account usable capital to deploy
}

export interface StrikesCfg {
  underlying: string | null
  expiry: string | null // null = nearest
  rows: StrikeRowCfg[]
}

// ---- depth panel stack (left dock bottom) ----
export interface DepthPanelCfg {
  id: string
  symbol: string
  height: number // px, adjustable by dragging the panel's top edge
}

export function defaultDepthPanels(symbol: string): DepthPanelCfg[] {
  return [{ id: `dp-${symbol.toLowerCase()}`, symbol, height: 190 }]
}

// ---- multi-pane chart layouts ----
export type WsLayout = 'single' | 'spot-atm' | 'grid4'

export interface PaneCfg {
  key: 'ce' | 'pe' | 'extra'
  strike: number | null // null = follow live ATM (CE/PE panes)
  type: 'CE' | 'PE' | null // only used by the 'extra' scratch pane
}

export function wsLayout(ws: WorkspaceCfg): WsLayout {
  return ws.layout ?? (ws.showOptionMinis ? 'spot-atm' : 'single')
}

export function defaultPanes(): PaneCfg[] {
  return [
    { key: 'ce', strike: null, type: 'CE' },
    { key: 'pe', strike: null, type: 'PE' },
    { key: 'extra', strike: null, type: null },
  ]
}

export function wsPanes(ws: WorkspaceCfg): PaneCfg[] {
  const base = ws.panes ?? defaultPanes()
  // repair panes missing from older persisted workspaces
  return defaultPanes().map(d => base.find(p => p.key === d.key) ?? d)
}

/** Pin a strike into its side pane (CE row -> CE pane, PE row -> PE pane);
 *  the extra scratch pane always mirrors the most recent click. */
export function pinStrikePanes(ws: WorkspaceCfg, strike: number, type: 'CE' | 'PE'): Partial<WorkspaceCfg> {
  return {
    panes: wsPanes(ws).map(p => {
      if (p.key === type.toLowerCase()) return { ...p, strike }
      if (p.key === 'extra') return { ...p, strike, type }
      return p
    }),
  }
}

export function unpinPane(ws: WorkspaceCfg, key: PaneCfg['key']): Partial<WorkspaceCfg> {
  return { panes: wsPanes(ws).map(p => (p.key === key ? { ...p, strike: null, type: p.key === 'extra' ? null : p.type } : p)) }
}

export interface WorkspaceCfg {
  id: string
  name: string
  symbol: string
  tf: Timeframe
  chartType: 'candles' | 'line' | 'area'
  showVolume: boolean
  showSMA20: boolean
  showSMA50: boolean
  showOptionMinis?: boolean // legacy (pre-layout) — kept for persisted-state migration
  layout?: WsLayout
  panes?: PaneCfg[]
  strikes?: StrikesCfg
  depthPanels?: DepthPanelCfg[]
}

export function defaultStrikes(): StrikesCfg {
  return { underlying: null, expiry: null, rows: [] }
}

interface TerminalState {
  view: AppView
  workspaces: WorkspaceCfg[]
  activeWs: string
  selectedSymbol: string
  // order pad state (shared + synced from chart/panels)
  side: OrderSide
  orderType: OrderTypeKind
  productType: ProductType
  qty: number
  qtyMode: 'AUTO' | 'MANUAL'
  limitPrice: number | null
  bottomTab: 'orders' | 'trades' | 'positions' | 'funds' | 'logs'
  // actions
  setView: (v: AppView) => void
  setSymbol: (s: string) => void
  patchWs: (id: string, patch: Partial<WorkspaceCfg>) => void
  addWs: () => void
  removeWs: (id: string) => void
  setActiveWs: (id: string) => void
  setSide: (s: OrderSide) => void
  setOrderType: (t: OrderTypeKind) => void
  setProductType: (p: ProductType) => void
  setQty: (q: number) => void
  setQtyMode: (m: 'AUTO' | 'MANUAL') => void
  setLimitPrice: (p: number | null) => void
  setBottomTab: (t: 'orders' | 'trades' | 'positions' | 'funds' | 'logs') => void
}

const mkWs = (id: string, name: string, symbol: string): WorkspaceCfg => ({
  id, name, symbol, tf: '5m', chartType: 'candles', showVolume: true, showSMA20: false, showSMA50: false,
  showOptionMinis: true, layout: 'spot-atm', panes: defaultPanes(), strikes: defaultStrikes(),
  depthPanels: defaultDepthPanels(symbol),
})

export const useTerminal = create<TerminalState>()(
  persist(
    (set, get) => ({
      view: 'terminal',
      workspaces: [mkWs('ws1', 'Workspace 1', 'NIFTY'), mkWs('ws2', 'Hedge Desk', 'BANKNIFTY')],
      activeWs: 'ws1',
      selectedSymbol: 'NIFTY',
      side: 'BUY',
      orderType: 'MARKET',
      productType: 'MIS',
      qty: 1,
      qtyMode: 'AUTO',
      limitPrice: null,
      bottomTab: 'orders',
      setView: v => set({ view: v }),
      setSymbol: s => {
        const { activeWs, workspaces } = get()
        set({
          selectedSymbol: s,
          workspaces: workspaces.map(w => (w.id === activeWs ? { ...w, symbol: s } : w)),
        })
      },
      patchWs: (id, patch) => set({ workspaces: get().workspaces.map(w => (w.id === id ? { ...w, ...patch } : w)) }),
      addWs: () => {
        const n = get().workspaces.length + 1
        const ws = mkWs(`ws${Date.now().toString(36)}`, `Workspace ${n}`, get().selectedSymbol)
        set({ workspaces: [...get().workspaces, ws], activeWs: ws.id })
      },
      removeWs: id => {
        const rest = get().workspaces.filter(w => w.id !== id)
        if (rest.length === 0) return
        set({ workspaces: rest, activeWs: get().activeWs === id ? rest[0].id : get().activeWs })
      },
      setActiveWs: id => {
        const ws = get().workspaces.find(w => w.id === id)
        if (ws) set({ activeWs: id, selectedSymbol: ws.symbol })
      },
      setSide: s => set({ side: s }),
      setOrderType: t => set({ orderType: t }),
      setProductType: p => set({ productType: p }),
      setQty: q => set({ qty: Math.max(0, q) }),
      setQtyMode: m => set({ qtyMode: m }),
      setLimitPrice: p => set({ limitPrice: p }),
      setBottomTab: t => set({ bottomTab: t }),
    }),
    {
      name: 'zterm-workspaces',
      partialize: s => ({ workspaces: s.workspaces, activeWs: s.activeWs, productType: s.productType, qtyMode: s.qtyMode }),
      // Avoid SSR/CSR hydration mismatch: server renders defaults, client
      // must not rehydrate synchronously before the first render.
      // We call useTerminal.persist.rehydrate() inside a useEffect after mount.
      skipHydration: true,
    },
  ),
)
