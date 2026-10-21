'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { ExternalLink, Layers, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { CanvasChart } from '../chart/canvas-chart'
import { api, fmtMoney } from '../lib/client-api'
import type { OptionQuoteCell } from '../lib/client-api'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'
import type { Tick } from '@/lib/types'
import {
  useTerminal, wsLayout, wsPanes, unpinPane, defaultStrikes, addDepthPanelTo,
  type PaneCfg, type WorkspaceCfg,
} from '../lib/store'

// ============================================================
// Multi-pane chart region for F&O workspaces — fully resizable
// (drag the dividers between panes).
// - 'spot-atm': spot chart on top, ATM CE (left) + ATM PE (right)
//   panes below — default open for FNO.
// - 'grid4': 2x2 — spot, CE, PE + a scratch pane that mirrors
//   the most recent strike-row click.
// Panes follow the live side-ATM (hedge convention: CE ATM =
// floor(spot), PE ATM = ceil(spot)) until the user pins a
// strike by clicking a strike row; a pane header button unpins.
//
// ALL panes share the workspace timeframe (auto-locked) so the
// synced crosshair lines up across every open chart. Every pane
// header starts with a depth button that opens that chart's
// symbol in the bottom-left depth panel stack.
// ============================================================

/** Depth button — adds this chart's symbol to the left depth stack. */
export function DepthAddButton({ ws, symbol }: { ws: WorkspaceCfg; symbol: string }) {
  const patchWs = useTerminal(s => s.patchWs)
  const add = () => {
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id) ?? ws
    const { patch, error } = addDepthPanelTo(cur, symbol)
    if (error) { toast.info(error); return }
    patchWs(ws.id, patch)
    toast.success(`Depth panel added — ${symbol}`)
  }
  return (
    <button
      onClick={add}
      title={`Open ${symbol} market depth in the left depth stack`}
      className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
    >
      <Layers className="h-2.5 w-2.5" />
    </button>
  )
}

/** Slim header for the spot pane: [depth] SYMBOL · LTP chg% */
export function SpotPaneHeader({ ws }: { ws: WorkspaceCfg }) {
  const [tick, setTick] = useState<Tick | null>(null)
  useEffect(() => {
    subscribeTicks([ws.symbol])
    const off = onTicks(map => {
      const t = map[ws.symbol]
      if (t) setTick(t)
    })
    return () => { unsubscribeTicks([ws.symbol]); off() }
  }, [ws.symbol])

  const ltp = tick?.ltp ?? 0
  const prev = tick?.prevClose ?? 0
  const chgPct = ltp && prev ? ((ltp - prev) / prev) * 100 : null
  return (
    <div className="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9px] shrink-0 gap-1">
      <DepthAddButton ws={ws} symbol={ws.symbol} />
      <span className="font-bold tabular shrink-0">{ws.symbol}</span>
      <span className="text-muted-foreground shrink-0">SPOT</span>
      <button
        onClick={() => useTerminal.getState().setSymbol(ws.symbol)}
        className="text-muted-foreground hover:text-foreground truncate px-1 min-w-0"
        title="Set as active symbol (order pad + strikes panel)"
      >
        click to set active
      </button>
      <div className="flex-1 min-w-0" />
      <span className={`tabular font-bold shrink-0 ${ltp && chgPct !== null && chgPct >= 0 ? 'term-up' : 'term-down'}`}>
        {ltp ? fmtMoney(ltp) : '—'}
        {chgPct !== null && (
          <span className={chgPct >= 0 ? 'term-up' : 'term-down'}> {chgPct >= 0 ? '+' : ''}{chgPct.toFixed(1)}%</span>
        )}
      </span>
    </div>
  )
}

export function OptionPane({ ws, kind }: { ws: WorkspaceCfg; kind: PaneCfg['key'] }) {
  const patchWs = useTerminal(s => s.patchWs)
  const setSymbol = useTerminal(s => s.setSymbol)
  const st = ws.strikes ?? defaultStrikes()
  const pane = wsPanes(ws).find(p => p.key === kind) ?? { key: kind, strike: null, type: null }

  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const unds = undData?.underlyings ?? []
  const underlying = st.underlying && unds.some(u => u.underlying === st.underlying)
    ? st.underlying
    : unds.some(u => u.underlying === ws.symbol) ? ws.symbol : null

  const expiry = st.expiry
  const pinned = pane.strike
  const type: 'CE' | 'PE' = kind === 'pe' ? 'PE' : kind === 'ce' ? 'CE' : (pane.type ?? 'CE')

  const { data, isLoading, isError } = useQuery({
    queryKey: ['optionPane', underlying, expiry, kind, pinned ?? 0],
    queryFn: () => api.optionChain(underlying!, expiry, pinned ? [pinned] : []),
    enabled: !!underlying,
    refetchInterval: 2000,
    retry: false,
  })
  const meta = data?.meta ?? null

  const cell: (OptionQuoteCell & { strike: number }) | null = useMemo(() => {
    if (pinned) {
      const row = data?.rows.find(r => r.strike === pinned)
      if (!row) return null
      return type === 'CE' ? { ...row.ce, strike: pinned } : { ...row.pe, strike: pinned }
    }
    if (type === 'CE') return data?.atmCe ?? null
    return data?.atmPe ?? null
  }, [data, pinned, type])

  const offset = meta && cell
    ? Math.round((cell.strike - (type === 'CE' ? meta.ceAtm : meta.peAtm)) / meta.step)
    : null
  const tint = type === 'CE' ? '#00c896' : '#ff4d5e'

  // ---- scratch pane with nothing pinned: mirror the underlying spot ----
  if (kind === 'extra' && !pinned) {
    return (
      <div className="h-full flex flex-col min-w-0 min-h-0">
        <div className="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9px] shrink-0 gap-1">
          <DepthAddButton ws={ws} symbol={ws.symbol} />
          <span className="font-bold text-muted-foreground">SCRATCH</span>
          <span className="text-muted-foreground truncate px-1">{ws.symbol} · click a strike row to pin it here</span>
          <div className="flex-1 min-w-0" />
        </div>
        <div className="flex-1 min-h-0">
          <CanvasChart
            symbol={ws.symbol} tf={ws.tf} chartType={ws.chartType} showVolume={ws.showVolume}
            showSMA20={ws.showSMA20} showSMA50={ws.showSMA50}
            showEMA={ws.showEMA} showVWAP={ws.showVWAP} showBOLL={ws.showBOLL}
            showRSI={ws.showRSI} showMACD={ws.showMACD}
            showGhost={ws.showGhost} ghostStyle={ws.ghostStyle} scales={ws.scales}
            height="h-full"
          />
        </div>
      </div>
    )
  }

  const header = (
    <div className="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9px] shrink-0 gap-1">
      <DepthAddButton ws={ws} symbol={cell?.exists ? cell.symbol : ws.symbol} />
      <span className="font-bold tabular shrink-0" style={{ color: tint }}>
        {cell?.exists ? `${cell.strike} ${type}` : `${type} ·—`}
      </span>
      {offset !== null && (
        <span className="text-muted-foreground shrink-0" title="Offset from side ATM (steps)">
          {offset === 0 ? 'ATM' : offset > 0 ? `+${offset}` : offset}
        </span>
      )}
      <button
        onClick={() => cell?.exists && setSymbol(cell.symbol)}
        className="text-muted-foreground hover:text-foreground truncate px-1 min-w-0"
        title={`${meta?.underlying ?? ''} · ${meta?.expiry ?? ''} · lot ${meta?.lotSize ?? '—'} — click to set as active symbol`}
      >
        {meta ? `${meta.underlying} · ${meta.expiry} · L${meta.lotSize}` : '—'}
      </button>
      <span className={`tabular font-bold shrink-0 ${cell && cell.ltp >= cell.prevClose ? 'term-up' : 'term-down'}`}>
        {cell?.exists ? fmtMoney(cell.ltp) : '—'}
        {cell?.exists ? (
          <span className={cell.changePct >= 0 ? 'term-up' : 'term-down'}> {cell.changePct >= 0 ? '+' : ''}{cell.changePct.toFixed(1)}%</span>
        ) : null}
      </span>
      {pinned ? (
        <button
          onClick={() => patchWs(ws.id, unpinPane(ws, kind))}
          className="shrink-0 px-1 py-0.5 rounded bg-primary/25 text-foreground hover:bg-primary/40 flex items-center gap-0.5"
          title={`Pinned ${cell?.strike ?? pinned} — click to follow the live ATM again`}
        >
          <RotateCcw className="h-2.5 w-2.5" /> PIN
        </button>
      ) : (
        <span className="shrink-0 px-1 py-0.5 rounded bg-secondary/70 text-muted-foreground" title="Following the live side ATM">ATM</span>
      )}
      <button
        onClick={() => cell?.exists && setSymbol(cell.symbol)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title="Set as active symbol (order pad + main chart)"
      >
        <ExternalLink className="h-2.5 w-2.5" />
      </button>
    </div>
  )

  let body: React.ReactNode
  if (!underlying) {
    body = <Placeholder text="Pick an F&O underlying in the Strikes panel" />
  } else if (isLoading) {
    body = <Placeholder text={`Loading ${type} chain…`} />
  } else if (isError || !meta) {
    body = <Placeholder text={`No F&O chain for ${underlying}`} />
  } else if (!cell?.exists) {
    body = <Placeholder text={`${pinned ? `${pinned} ` : 'ATM '}${type} contract unavailable`} />
  } else {
    body = (
      <CanvasChart
        symbol={cell.symbol}
        tf={ws.tf} // interval auto-locked to the workspace — synced crosshair aligns
        chartType={ws.chartType}
        showVolume={ws.showVolume}
        showSMA20={false}
        showSMA50={false}
        showEMA={ws.showEMA}
        showVWAP={ws.showVWAP}
        showBOLL={ws.showBOLL}
        showRSI={ws.showRSI}
        showMACD={ws.showMACD}
        showGhost={ws.showGhost} ghostStyle={ws.ghostStyle} scales={ws.scales}
        height="h-full"
      />
    )
  }

  return (
    <div className="h-full flex flex-col min-w-0 min-h-0">
      {header}
      <div className="flex-1 min-h-0">{body}</div>
    </div>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground px-2 text-center">
      {text}
    </div>
  )
}

/** Divider between chart panes (drag to resize). */
function PaneHandle({ horizontal = false }: { horizontal?: boolean }) {
  return (
    <PanelResizeHandle
      className={horizontal ? 'w-px bg-border hover:bg-primary/60 transition-colors' : 'h-px bg-border hover:bg-primary/60 transition-colors'}
    />
  )
}

/** Full multi-pane region for a workspace (spot + option panes) — all panes resizable. */
export function WorkspacePanes({ ws, spot }: { ws: WorkspaceCfg; spot: React.ReactNode }) {
  const layout = wsLayout(ws)
  const spotWithHeader = (
    <div className="h-full flex flex-col min-w-0 min-h-0">
      <SpotPaneHeader ws={ws} />
      <div className="flex-1 min-h-0">{spot}</div>
    </div>
  )
  if (layout === 'single') return spotWithHeader
  if (layout === 'grid4') {
    return (
      <PanelGroup direction="vertical" className="h-full">
        <Panel defaultSize={50} minSize={15}>
          <PanelGroup direction="horizontal" className="h-full">
            <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0">{spotWithHeader}</div></Panel>
            <PaneHandle horizontal />
            <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="ce" /></div></Panel>
          </PanelGroup>
        </Panel>
        <PaneHandle />
        <Panel defaultSize={50} minSize={15}>
          <PanelGroup direction="horizontal" className="h-full">
            <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="pe" /></div></Panel>
            <PaneHandle horizontal />
            <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="extra" /></div></Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    )
  }
  // 'spot-atm' (default): spot on top, ATM CE left + PE right below — all resizable
  return (
    <PanelGroup direction="vertical" className="h-full">
      <Panel defaultSize={58} minSize={20}><div className="h-full min-w-0">{spotWithHeader}</div></Panel>
      <PaneHandle />
      <Panel defaultSize={42} minSize={15}>
        <PanelGroup direction="horizontal" className="h-full">
          <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="ce" /></div></Panel>
          <PaneHandle horizontal />
          <Panel defaultSize={50} minSize={15}><div className="h-full min-w-0"><OptionPane ws={ws} kind="pe" /></div></Panel>
        </PanelGroup>
      </Panel>
    </PanelGroup>
  )
}
