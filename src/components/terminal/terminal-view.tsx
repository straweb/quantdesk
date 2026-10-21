'use client'

import { useMemo, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useQuery } from '@tanstack/react-query'
import { ListTree, FileBox, Plus, X, Crosshair } from 'lucide-react'
import { CanvasChart } from './chart/canvas-chart'
import { Watchlist, MarketDepth } from './panels/watchlist'
import { OrderPad, QuickButtons } from './panels/order-pad'
import { BottomPanel } from './panels/bottom-panel'
import { StrikesPanel } from './panels/strikes-panel'
import { WorkspacePanes } from './panels/option-panes'
import { useTerminal, wsLayout, type WsLayout } from './lib/store'
import { api } from './lib/client-api'
import { TIMEFRAMES } from '@/lib/types'
import type { Timeframe } from '@/lib/types'

export function TerminalView() {
  const workspaces = useTerminal(s => s.workspaces)
  const activeWs = useTerminal(s => s.activeWs)
  const ws = workspaces.find(w => w.id === activeWs) ?? workspaces[0]
  const patchWs = useTerminal(s => s.patchWs)
  const setLimitPrice = useTerminal(s => s.setLimitPrice)
  const setOrderType = useTerminal(s => s.setOrderType)

  const { data: posData } = useQuery({ queryKey: ['positions'], queryFn: () => api.positions(), refetchInterval: 2000 })

  // F&O underlyings -> enable the spot+ATM CE/PE mini charts strip
  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const layout = ws ? wsLayout(ws) : 'single'
  const isFnOUnderlying = useMemo(
    () => !!ws && (undData?.underlyings ?? []).some(u => u.underlying === ws.symbol),
    [ws, undData],
  )

  const markers = useMemo(() => {
    if (!ws || !posData) return []
    return posData.positions
      .filter(p => p.symbol === ws.symbol && p.netQty !== 0 && p.avgPrice > 0)
      .map(p => ({
        price: p.avgPrice,
        label: p.netQty > 0 ? 'L' : 'S',
        color: p.netQty > 0 ? '#00c896' : '#ff4d5e',
      }))
  }, [ws, posData])

  if (!ws) return null

  return (
    <div className="flex h-full flex-col">
      {/* workspace tabs + chart toolbar */}
      <div className="flex items-center gap-1 px-2 pt-1 border-b border-border bg-card/30">
        <WorkspaceTabs />
        <div className="flex-1" />
        <div className="flex items-center gap-1 text-[10px]">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              onClick={() => patchWs(ws.id, { tf: tf as Timeframe })}
              className={`px-1.5 py-0.5 rounded ${ws.tf === tf ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >{tf}</button>
          ))}
          <span className="w-px h-4 bg-border mx-1" />
          {(['candles', 'line', 'area'] as const).map(t => (
            <button
              key={t}
              onClick={() => patchWs(ws.id, { chartType: t })}
              className={`px-1.5 py-0.5 rounded capitalize ${ws.chartType === t ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >{t}</button>
          ))}
          <span className="w-px h-4 bg-border mx-1" />
          <button
            onClick={() => patchWs(ws.id, { showVolume: !ws.showVolume })}
            className={`px-1.5 py-0.5 rounded ${ws.showVolume ? 'bg-accent text-foreground' : 'bg-secondary text-muted-foreground'}`}
          >Vol</button>
          <span className="w-px h-4 bg-border mx-0.5" />
          {([
            ['single', '1', 'Single chart pane'],
            ['spot-atm', 'S+2', 'Spot top · ATM CE / PE panes below'],
            ['grid4', '2×2', 'Spot + CE + PE + scratch pane'],
          ] as [WsLayout, string, string][]).map(([l, label, tip]) => (
            <button
              key={l}
              onClick={() => patchWs(ws.id, { layout: l, showOptionMinis: l !== 'single' })}
              title={tip}
              className={`px-1.5 py-0.5 rounded text-[10px] tabular ${layout === l ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >{label}</button>
          ))}
          <span className="w-px h-4 bg-border mx-0.5" />
          <button
            onClick={() => patchWs(ws.id, { showSMA20: !ws.showSMA20 })}
            className={`px-1.5 py-0.5 rounded text-[#4dd0e1] ${ws.showSMA20 ? 'bg-accent' : 'bg-secondary/60'}`}
          >MA20</button>
          <button
            onClick={() => patchWs(ws.id, { showSMA50: !ws.showSMA50 })}
            className={`px-1.5 py-0.5 rounded text-[#b48ce8] ${ws.showSMA50 ? 'bg-accent' : 'bg-secondary/60'}`}
          >MA50</button>
          <span
            className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground flex items-center gap-1"
            title="Scroll: zoom · Drag: pan · Double-click: reset · Click price: set limit"
          >
            <Crosshair className="h-3 w-3" /> zoom/pan
          </span>
        </div>
      </div>

      {/* main grid */}
      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal">
          {/* left: watchlist + depth */}
          <Panel defaultSize={17} minSize={12} maxSize={28}>
            <div className="h-full flex flex-col border-r border-border">
              <div className="flex-1 min-h-0"><Watchlist /></div>
              <div className="border-t border-border"><MarketDepth /></div>
            </div>
          </Panel>
          <Handle />
          {/* center: multi-pane charts (spot + CE/PE per layout) + bottom */}
          <Panel defaultSize={65} minSize={30}>
            <PanelGroup direction="vertical">
              <Panel defaultSize={isFnOUnderlying ? 56 : 68} minSize={25}>
                <div className="h-full min-h-0">
                  <WorkspacePanes
                    ws={ws}
                    spot={
                      <CanvasChart
                        symbol={ws.symbol}
                        tf={ws.tf}
                        chartType={ws.chartType}
                        showVolume={ws.showVolume}
                        showSMA20={ws.showSMA20}
                        showSMA50={ws.showSMA50}
                        markers={markers}
                        onPriceClick={p => { setLimitPrice(p); setOrderType('LIMIT') }}
                        height="h-full"
                      />
                    }
                  />
                </div>
              </Panel>
              <Handle vertical />
              <Panel defaultSize={isFnOUnderlying ? 44 : 32} minSize={12}>
                <BottomPanel />
              </Panel>
            </PanelGroup>
          </Panel>
          <Handle />
          {/* right: strikes panel / order pad + quick buttons (compact) */}
          <Panel defaultSize={18} minSize={13} maxSize={34}>
            <RightDock ws={ws} />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  )
}

function WorkspaceTabs() {
  const workspaces = useTerminal(s => s.workspaces)
  const activeWs = useTerminal(s => s.activeWs)
  const setActiveWs = useTerminal(s => s.setActiveWs)
  const addWs = useTerminal(s => s.addWs)
  const removeWs = useTerminal(s => s.removeWs)

  return (
    <div className="flex items-center gap-1">
      {workspaces.map(w => (
        <div
          key={w.id}
          onClick={() => setActiveWs(w.id)}
          className={`group flex items-center gap-1 px-2.5 py-1 rounded-t text-[11px] cursor-pointer border-b-2 transition-colors ${
            activeWs === w.id ? 'border-primary text-foreground bg-card/60' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <span>{w.name}</span>
          <span className="text-[9px] text-muted-foreground">{w.symbol}</span>
          {workspaces.length > 1 && (
            <X
              className="h-3 w-3 opacity-0 group-hover:opacity-60 hover:!opacity-100"
              onClick={e => { e.stopPropagation(); removeWs(w.id) }}
            />
          )}
        </div>
      ))}
      <button onClick={addWs} className="p-1 rounded text-muted-foreground hover:text-foreground" title="New workspace">
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function Handle({ vertical = false }: { vertical?: boolean }) {
  return (
    <PanelResizeHandle className={vertical ? 'h-px bg-border hover:bg-primary/50 transition-colors' : 'w-px bg-border hover:bg-primary/50 transition-colors'} />
  )
}

// Right dock: Strikes panel | Order pad tabs + global quick buttons
function RightDock({ ws }: { ws: NonNullable<ReturnType<typeof useTerminal.getState>['workspaces'][number]> }) {
  const [tab, setTab] = useState<'strikes' | 'order'>('strikes')

  return (
    <div className="h-full flex flex-col border-l border-border">
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-border bg-card/30 shrink-0">
        <button
          onClick={() => setTab('strikes')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${tab === 'strikes' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          <ListTree className="h-3 w-3" /> Strikes
        </button>
        <button
          onClick={() => setTab('order')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${tab === 'order' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          <FileBox className="h-3 w-3" /> Order Pad
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'strikes' ? <StrikesPanel ws={ws} /> : <OrderPad />}
      </div>
      <QuickButtons />
    </div>
  )
}
