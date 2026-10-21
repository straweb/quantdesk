'use client'

import { useMemo, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useQuery } from '@tanstack/react-query'
import { ListTree, FileBox, Plus, X, Crosshair, Layers, Bot, Ghost, Ruler } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CanvasChart } from './chart/canvas-chart'
import { Watchlist, DepthStack } from './panels/watchlist'
import { OrderPad } from './panels/order-pad'
import { BottomPanel } from './panels/bottom-panel'
import { StrikesPanel } from './panels/strikes-panel'
import { AutoPanel } from './panels/auto-panel'
import { WorkspacePanes } from './panels/option-panes'
import { useTerminal, wsLayout, addDepthPanelTo, type WsLayout, type WorkspaceCfgFlags } from './lib/store'
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
          {([
            ['showSMA20', 'MA20', 'text-[#4dd0e1]'],
            ['showSMA50', 'MA50', 'text-[#b48ce8]'],
            ['showEMA', 'EMA', 'text-[#ffd166]'],
            ['showVWAP', 'VWAP', 'text-[#4dd0e1]'],
            ['showBOLL', 'BB', 'text-muted-foreground'],
          ] as [keyof WorkspaceCfgFlags, string, string][]).map(([key, label, tint]) => (
            <button
              key={label}
              onClick={() => patchWs(ws.id, { [key]: !ws[key] })}
              title={`${label} overlay`}
              className={`px-1.5 py-0.5 rounded text-[10px] ${tint} ${ws[key] ? 'bg-accent' : 'bg-secondary/60 text-muted-foreground'}`}
            >{label}</button>
          ))}
          {([
            ['showRSI', 'RSI'],
            ['showMACD', 'MACD'],
          ] as [keyof WorkspaceCfgFlags, string][]).map(([key, label]) => (
            <button
              key={label}
              onClick={() => patchWs(ws.id, { [key]: !ws[key] })}
              title={`${label} sub-panel`}
              className={`px-1.5 py-0.5 rounded text-[10px] text-[#f5a623] ${ws[key] ? 'bg-accent' : 'bg-secondary/60 text-muted-foreground'}`}
            >{label}</button>
          ))}
          <span className="w-px h-4 bg-border mx-0.5" />
          {/* 1M ghost (#ghostCtl) + scales popover */}
          <button
            onClick={() => patchWs(ws.id, { showGhost: !ws.showGhost })}
            title="1M GHOST — overlay 1-minute candles on higher-timeframe charts"
            className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-[#e0a63f] ${ws.showGhost ? 'bg-accent' : 'bg-secondary/60 text-muted-foreground'}`}
          >
            <Ghost className="h-3 w-3" /> 1m
          </button>
          {ws.showGhost && (
            <div className="flex rounded overflow-hidden border border-border">
              {(['hollow', 'fade'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => patchWs(ws.id, { ghostStyle: s })}
                  className={`px-1 py-0.5 text-[8px] uppercase ${(ws.ghostStyle ?? 'hollow') === s ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}
                >{s}</button>
              ))}
            </div>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <button
                title="Axis scales — topmost enabled = right axis, others = left measurement column. % / pts are relative to the baseline (drag it, or set by clicking the chart)."
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground bg-secondary/60"
              >
                <Ruler className="h-3 w-3" /> scales
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-2.5 text-[10px] space-y-2">
              <div className="text-[8px] uppercase tracking-wide text-muted-foreground">topmost enabled = right axis · others = left measurement column</div>
              {([
                ['price', 'Price'],
                ['pct', 'Percent'],
                ['inv', 'Inverted % (sellers)'],
                ['pts', 'Points'],
              ] as [keyof NonNullable<typeof ws.scales>, string][]).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!ws.scales?.[k]}
                    onChange={e => patchWs(ws.id, { scales: { price: true, pct: false, inv: false, pts: false, ...(ws.scales ?? {}), [k]: e.target.checked } })}
                    className="accent-[#3b82f6]"
                  />
                  <span>{label}</span>
                </label>
              ))}
              <button
                onClick={() => window.dispatchEvent(new Event('qd-chart-set-base'))}
                className="w-full mt-1 px-2 py-1 rounded bg-[#e0a63f]/20 border border-[#e0a63f]/40 text-[#e0a63f] font-semibold hover:bg-[#e0a63f]/30"
              >
                Set baseline — then click a chart
              </button>
              <div className="text-[8px] text-muted-foreground leading-snug">
                The baseline is the amber dashed line: drag it to rearrange, double-click the chart to reset it to the session open.
              </div>
            </PopoverContent>
          </Popover>
          <span className="w-px h-4 bg-border mx-0.5" />
          <button
            onClick={() => {
              const { patch, error } = addDepthPanelTo(ws, ws.symbol)
              if (error) { toast.info(error); return }
              patchWs(ws.id, patch)
              toast.success(`Depth panel added — ${ws.symbol}`)
            }}
            title="Add this chart's market depth to the left depth stack"
            className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <Layers className="h-3 w-3" /> depth
          </button>
          <span
            className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground flex items-center gap-1"
            title="Wheel: time zoom · Wheel on price axis / Shift+wheel: price zoom · Drag: free pan (all directions, 50 bars future space) · Drag price axis: squeeze/stretch · Double-click / ▶LIVE: reset to live · Hover: synced crosshair across all charts"
          >
            <Crosshair className="h-3 w-3" /> zoom/pan
          </span>
        </div>
      </div>

      {/* main grid */}
      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal">
          {/* left: watchlist + depth panel stack */}
          <Panel defaultSize={17} minSize={12} maxSize={28}>
            <div className="h-full flex flex-col border-r border-border">
              <div className="flex-1 min-h-0"><Watchlist /></div>
              <DepthStack ws={ws} />
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
                        showEMA={ws.showEMA}
                        showVWAP={ws.showVWAP}
                        showBOLL={ws.showBOLL}
                        showRSI={ws.showRSI}
                        showMACD={ws.showMACD}
                        showGhost={ws.showGhost}
                        ghostStyle={ws.ghostStyle}
                        scales={ws.scales}
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

// Right dock: Strikes panel | Auto rules | Order pad
type RightTab = 'strikes' | 'auto' | 'order'
function RightDock({ ws }: { ws: NonNullable<ReturnType<typeof useTerminal.getState>['workspaces'][number]> }) {
  const [tab, setTab] = useState<RightTab>('strikes')

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
          onClick={() => setTab('auto')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${tab === 'auto' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          <Bot className="h-3 w-3" /> Auto
        </button>
        <button
          onClick={() => setTab('order')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${tab === 'order' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          <FileBox className="h-3 w-3" /> Order Pad
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'strikes' ? <StrikesPanel ws={ws} /> : tab === 'auto' ? <AutoPanel ws={ws} /> : <OrderPad />}
      </div>
    </div>
  )
}
