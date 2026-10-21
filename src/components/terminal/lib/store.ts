'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Timeframe, OrderSide, OrderTypeKind, ProductType } from '@/lib/types'

export type AppView = 'terminal' | 'admin' | 'strategy'

export interface WorkspaceCfg {
  id: string
  name: string
  symbol: string
  tf: Timeframe
  chartType: 'candles' | 'line' | 'area'
  showVolume: boolean
  showSMA20: boolean
  showSMA50: boolean
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
    },
  ),
)
