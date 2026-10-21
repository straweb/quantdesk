'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, RotateCcw } from 'lucide-react'
import { CanvasChart } from '../chart/canvas-chart'
import { api, fmtMoney } from '../lib/client-api'
import type { OptionQuoteCell } from '../lib/client-api'
import { useTerminal, wsLayout, wsPanes, unpinPane, defaultStrikes, type PaneCfg, type WorkspaceCfg } from '../lib/store'

// ============================================================
// Multi-pane chart region for F&O workspaces.
// - 'spot-atm': spot chart on top (full width), ATM CE (left) +
//   ATM PE (right) panes below — default open for FNO.
// - 'grid4': 2x2 — spot, CE, PE + a scratch pane that mirrors
//   the most recent strike-row click.
// Panes follow the live side-ATM (hedge convention: CE ATM =
// floor(spot), PE ATM = ceil(spot)) until the user pins a
// strike by clicking a strike row; a pane header button unpins.
// ============================================================

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
        <div className="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9px] shrink-0">
          <span className="font-bold text-muted-foreground">SCRATCH</span>
          <span className="text-muted-foreground truncate px-1">{ws.symbol} · click a strike row to pin it here</span>
        </div>
        <div className="flex-1 min-h-0">
          <CanvasChart symbol={ws.symbol} tf={ws.tf} chartType={ws.chartType} showVolume={false} showSMA20={false} showSMA50={false} height="h-full" />
        </div>
      </div>
    )
  }

  const header = (
    <div className="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9px] shrink-0 gap-1">
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
        tf="1m"
        chartType="candles"
        showVolume={false}
        showSMA20={false}
        showSMA50={false}
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

/** Full multi-pane region for a workspace (spot + option panes). */
export function WorkspacePanes({ ws, spot }: { ws: WorkspaceCfg; spot: React.ReactNode }) {
  const layout = wsLayout(ws)
  if (layout === 'single') return <>{spot}</>
  if (layout === 'grid4') {
    return (
      <div className="h-full grid grid-cols-2 grid-rows-2 gap-px bg-border/70">
        <div className="bg-card min-w-0 min-h-0">{spot}</div>
        <div className="bg-card min-w-0 min-h-0"><OptionPane ws={ws} kind="ce" /></div>
        <div className="bg-card min-w-0 min-h-0"><OptionPane ws={ws} kind="pe" /></div>
        <div className="bg-card min-w-0 min-h-0"><OptionPane ws={ws} kind="extra" /></div>
      </div>
    )
  }
  // 'spot-atm' (default): spot on top, ATM CE left + PE right below
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0">{spot}</div>
      <div className="h-[34%] min-h-[150px] shrink-0 border-t border-border grid grid-cols-2 gap-px bg-border/70">
        <div className="bg-card min-w-0 min-h-0"><OptionPane ws={ws} kind="ce" /></div>
        <div className="bg-card min-w-0 min-h-0"><OptionPane ws={ws} kind="pe" /></div>
      </div>
    </div>
  )
}
