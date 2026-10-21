'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, GripHorizontal, Layers, Plus, Search, Star, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { api, fmtMoney, type SymbolRow } from '../lib/client-api'
import type { IndexComponentRow, IndexComponentsResp } from '../lib/client-api'
import { useTerminal, defaultDepthPanels, addDepthPanelTo, type DepthPanelCfg, type WorkspaceCfg } from '../lib/store'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'
import { useSyncData } from '../lib/sync'
import type { Tick } from '@/lib/types'

// ============================================================
// Left panel — watchlist of tabs:
//  · Watch — the user's starred symbols (persisted)
//  · Index — all indices; the arrow expands the constituent stocks
//    with H / LTP / L / Vol / chg% / contribution pts to the index
//  · Eq / Fut / Opt — filtered master-contract lists
// Clicking any row opens (or re-activates) that symbol's workspace —
// F&O underlyings load the spot + ATM CE/PE layout with the strikes
// panel pre-bound. The market-depth stack below renders quantity in
// LOTS whenever the instrument has a lot size, else raw shares.
// ============================================================

type WlTab = 'watch' | 'index' | 'eq' | 'fut' | 'opt'

const TABS: [WlTab, string][] = [
  ['watch', 'Watch'],
  ['index', 'Index'],
  ['eq', 'Eq'],
  ['fut', 'Fut'],
  ['opt', 'Opt'],
]

export function Watchlist() {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<WlTab>('watch')
  const [ticks, setTicks] = useState<Record<string, Tick>>({})
  const [expandedIdx, setExpandedIdx] = useState<string | null>(null)
  const selectedSymbol = useTerminal(s => s.selectedSymbol)
  const watchSymbols = useTerminal(s => s.watchSymbols)
  const toggleWatch = useTerminal(s => s.toggleWatch)
  const openSymbolWorkspace = useTerminal(s => s.openSymbolWorkspace)

  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const fnoSet = useMemo(() => new Set((undData?.underlyings ?? []).map(u => u.underlying)), [undData])
  const indexMeta = useMemo(() => new Map((undData?.underlyings ?? []).map(u => [u.underlying, u])), [undData])

  const typeFilter = tab === 'eq' ? 'EQ' : tab === 'fut' ? 'FUT' : tab === 'opt' ? 'OPT' : ''
  const { data } = useQuery({
    queryKey: ['symbols', q, typeFilter],
    queryFn: () => api.symbols(q, typeFilter),
    refetchInterval: 60_000,
    enabled: tab !== 'watch' && tab !== 'index',
  })

  // rows for Eq/Fut/Opt tabs
  const symbols = useMemo(() => {
    const list = data?.symbols ?? []
    const rank = (r: SymbolRow) => (r.instrumentType === 'INDEX' ? 0 : r.instrumentType === 'EQ' ? 1 : r.instrumentType === 'FUT' ? 2 : 3)
    return [...list].sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol)).slice(0, 60)
  }, [data])

  // Watch tab rows — starred symbols resolved against master contracts
  const { data: watchData } = useQuery({
    queryKey: ['symbols-watch', watchSymbols.join(',')],
    queryFn: () => api.symbolsByList(watchSymbols),
    refetchInterval: 60_000,
    enabled: tab === 'watch' && watchSymbols.length > 0,
  })
  const watchRows = useMemo(() => {
    const map = new Map((watchData?.symbols ?? []).map(s => [s.symbol, s]))
    const out: SymbolRow[] = []
    for (const sym of watchSymbols) {
      const row = map.get(sym)
      if (row) out.push(row)
      else out.push({ id: `adhoc-${sym}`, symbol: sym, name: sym, exchange: '—', instrumentType: fnoSet.has(sym) ? 'INDEX' : 'EQ', lotSize: indexMeta.get(sym)?.lotSize ?? 1, mappings: [] })
    }
    return out
  }, [watchData, watchSymbols, fnoSet, indexMeta])

  // Index tab rows — all indices
  const { data: idxData } = useQuery({
    queryKey: ['symbols-index'],
    queryFn: () => api.symbols('', 'INDEX'),
    refetchInterval: 60_000,
    enabled: tab === 'index',
  })
  const indexRows = useMemo(() => (idxData?.symbols ?? []).slice(0, 20), [idxData])

  const listed = tab === 'watch' ? watchRows : tab === 'index' ? indexRows : symbols
  // search box also filters the Watch / Index tabs (Eq/Fut/Opt filter server-side)
  const visible = q && (tab === 'watch' || tab === 'index')
    ? listed.filter(s => s.symbol.includes(q) || (s.name ?? '').toUpperCase().includes(q))
    : listed
  const visibleKey = visible.map(s => s.symbol).join(',')
  useEffect(() => {
    const list = visibleKey ? visibleKey.split(',') : []
    subscribeTicks(list)
    return () => unsubscribeTicks(list)
  }, [visibleKey])

  useEffect(() => onTicks(setTicks), [])

  const openWs = (symbol: string) => openSymbolWorkspace(symbol, fnoSet.has(symbol))

  return (
    <div className="flex h-full flex-col">
      <div className="p-2 space-y-1.5 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={e => setQ(e.target.value.toUpperCase())}
            placeholder="Search… (enter opens a workspace)"
            className="h-8 pl-7 text-xs bg-secondary/60"
          />
        </div>
        <div className="flex gap-0.5">
          {TABS.map(([v, l]) => (
            <button
              key={v}
              onClick={() => setTab(v)}
              className={`flex-1 px-1 py-0.5 text-[10px] rounded ${tab === v ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >
              {l}
            </button>
          ))}
        </div>
        {q && tab !== 'watch' && tab !== 'index' && (
          <div className="text-[8px] text-muted-foreground">searching “{q}” — click a result to open its workspace</div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* Index tab: expandable constituent lists */}
        {tab === 'index' && visible.map(s => (
          <IndexRow
            key={s.id}
            symbol={s.symbol}
            name={s.name}
            lotSize={s.lotSize}
            tick={ticks[s.symbol]}
            active={s.symbol === selectedSymbol}
            starred={watchSymbols.includes(s.symbol)}
            onStar={() => toggleWatch(s.symbol)}
            onOpen={() => openWs(s.symbol)}
            onOpenSymbol={sym => openSymbolWorkspace(sym, false)}
            expanded={expandedIdx === s.symbol}
            onToggle={() => setExpandedIdx(expandedIdx === s.symbol ? null : s.symbol)}
          />
        ))}
        {/* other tabs / search results */}
        {tab !== 'index' && visible.map(s => (
          <SymbolRowItem
            key={s.id}
            row={s}
            tick={ticks[s.symbol]}
            active={s.symbol === selectedSymbol}
            starred={watchSymbols.includes(s.symbol)}
            onStar={() => toggleWatch(s.symbol)}
            onOpen={() => openWs(s.symbol)}
          />
        ))}
        {visible.length === 0 && (
          <div className="p-4 text-center text-[11px] text-muted-foreground">
            {tab === 'watch' ? 'No starred symbols — tap the star on any row.' : 'No symbols. Sync master contracts in Admin.'}
          </div>
        )}
      </div>
    </div>
  )
}

function starBtn(starred: boolean, onStar: () => void) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onStar() }}
      title={starred ? 'Remove from Watch tab' : 'Star → Watch tab'}
      className={`p-0.5 rounded shrink-0 ${starred ? 'text-[#e0a63f]' : 'text-muted-foreground/40 hover:text-[#e0a63f]'}`}
    >
      <Star className="h-3 w-3" fill={starred ? 'currentColor' : 'none'} />
    </button>
  )
}

function SymbolRowItem({ row, tick, active, starred, onStar, onOpen }: {
  row: SymbolRow
  tick?: Tick
  active: boolean
  starred: boolean
  onStar: () => void
  onOpen: () => void
}) {
  const ltp = tick?.ltp ?? row.basePrice ?? 0
  const chg = tick && tick.prevClose ? ((tick.ltp - tick.prevClose) / tick.prevClose) * 100 : 0
  const up = chg >= 0
  return (
    <div
      onClick={onOpen}
      className={`w-full px-2 py-1.5 flex items-center justify-between text-left border-l-2 cursor-pointer transition-colors ${
        active ? 'border-primary bg-accent' : 'border-transparent hover:bg-secondary/50'
      }`}
    >
      <div className="min-w-0">
        <div className="text-[11px] font-medium truncate">{row.symbol}</div>
        <div className="text-[9px] text-muted-foreground">
          {row.exchange} · {row.instrumentType}{row.instrumentType === 'EQ' ? ` · L${row.lotSize}` : ''}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <div className="text-right tabular">
          <div className={`text-[11px] ${tick ? (tick.ltp >= (tick.prevClose || tick.ltp) ? 'term-up' : 'term-down') : ''}`}>
            {ltp ? ltp.toFixed(2) : '—'}
          </div>
          <div className={`text-[9px] ${up ? 'term-up' : 'term-down'}`}>
            {tick ? `${up ? '+' : ''}${chg.toFixed(2)}%` : '—'}
          </div>
        </div>
        {starBtn(starred, onStar)}
      </div>
    </div>
  )
}

function IndexRow({ symbol, name, lotSize, tick, active, starred, onStar, onOpen, onOpenSymbol, expanded, onToggle }: {
  symbol: string
  name: string
  lotSize: number
  tick?: Tick
  active: boolean
  starred: boolean
  onStar: () => void
  onOpen: () => void
  onOpenSymbol: (s: string) => void
  expanded: boolean
  onToggle: () => void
}) {
  const ltp = tick?.ltp ?? 0
  const chg = tick && tick.prevClose ? ((tick.ltp - tick.prevClose) / tick.prevClose) * 100 : 0
  const up = chg >= 0
  return (
    <div className={active ? 'bg-accent/60' : ''}>
      <div
        onClick={onOpen}
        className={`w-full px-2 py-1.5 flex items-center justify-between text-left border-l-2 cursor-pointer transition-colors ${
          active ? 'border-primary' : 'border-transparent hover:bg-secondary/50'
        }`}
      >
        <div className="flex items-center gap-1 min-w-0">
          <button
            onClick={e => { e.stopPropagation(); onToggle() }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground shrink-0"
            title={`${expanded ? 'Hide' : 'Show'} ${symbol} constituents`}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold truncate">{symbol}</div>
            <div className="text-[9px] text-muted-foreground truncate">{name} · L{lotSize}</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="text-right tabular">
            <div className={`text-[11px] ${tick ? (tick.ltp >= (tick.prevClose || tick.ltp) ? 'term-up' : 'term-down') : ''}`}>
              {ltp ? ltp.toFixed(2) : '—'}
            </div>
            <div className={`text-[9px] ${up ? 'term-up' : 'term-down'}`}>
              {tick ? `${up ? '+' : ''}${chg.toFixed(2)}%` : '—'}
            </div>
          </div>
          {starBtn(starred, onStar)}
        </div>
      </div>
      {expanded && <ConstituentList symbol={symbol} onOpenSymbol={onOpenSymbol} />}
    </div>
  )
}

/** Constituents of an expanded index: H / LTP / L / Vol / chg% / +pts contribution. */
function ConstituentList({ symbol, onOpenSymbol }: { symbol: string; onOpenSymbol: (s: string) => void }) {
  // realtime via sync:index (2s) — REST fallback when the hub has no payload yet
  const sync = useSyncData<IndexComponentsResp>(
    'sync:index',
    d => !!d && (d as { index?: { symbol?: string } }).index?.symbol === symbol,
    { index: [symbol] },
  )
  const { data: rest, isLoading, error } = useQuery({
    queryKey: ['index-components', symbol],
    queryFn: () => api.indexComponents(symbol),
    enabled: !sync,
    refetchInterval: 5000,
    retry: false,
  })
  const data = sync ?? rest

  const rows: (IndexComponentRow & { key: string })[] = useMemo(
    () => (data?.constituents ?? []).map(c => ({ ...c, key: c.symbol })),
    [data],
  )
  const sorted = useMemo(() => [...rows].sort((a, b) => b.pts - a.pts), [rows])

  if (isLoading) return <div className="px-6 py-2 text-[9px] text-muted-foreground">loading constituents…</div>
  if (error || !data) return <div className="px-6 py-2 text-[9px] text-muted-foreground">constituents unavailable</div>

  return (
    <div className="bg-[#0b0e11]/60 border-y border-border/60 py-1">
      <div className="flex items-center justify-between px-2.5 pb-1 text-[8px] uppercase tracking-wide text-muted-foreground">
        <span>contribution · Σ {data.totalPts >= 0 ? '+' : ''}{data.totalPts.toFixed(1)} pts</span>
        <span>H LTP L Vol chg%</span>
      </div>
      {sorted.map(c => {
        const up = c.chgPct >= 0
        return (
          <div
            key={c.key}
            onClick={() => onOpenSymbol(c.symbol)}
            className="px-2.5 py-1 flex items-center justify-between text-[10px] cursor-pointer hover:bg-secondary/40"
            title={`${c.symbol} — weight ${c.weight}% · click to open its workspace`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`tabular text-[9px] w-10 shrink-0 ${c.pts >= 0 ? 'term-up' : 'term-down'}`}>
                {c.pts >= 0 ? '+' : ''}{c.pts.toFixed(1)}
              </span>
              <span className="font-medium truncate">{c.symbol}</span>
              <span className="text-[8px] text-muted-foreground shrink-0">{c.weight}%</span>
            </div>
            <div className="flex items-center gap-2 tabular shrink-0 text-[9px]">
              <span className="text-muted-foreground">{fmtMoney(c.high, 0)}</span>
              <span className={`font-semibold ${up ? 'term-up' : 'term-down'}`}>{fmtMoney(c.ltp, 1)}</span>
              <span className="text-muted-foreground">{fmtMoney(c.low, 0)}</span>
              <span className="text-muted-foreground w-10 text-right">{fmtVolShort(c.vol)}</span>
              <span className={`w-12 text-right ${up ? 'term-up' : 'term-down'}`}>{up ? '+' : ''}{c.chgPct.toFixed(2)}%</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function fmtVol(v: number): string {
  if (v >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`
  if (v >= 1e5) return `${(v / 1e5).toFixed(1)}L`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(Math.round(v))
}
function fmtVolShort(v: number): string {
  return fmtVol(v)
}

// ------------------------------------------------------------
// Depth panel stack (bottom-left dock).
// N market-depth panels stacked top-to-bottom:
//  · [+] adds a depth panel for the currently selected symbol
//  · X removes a panel
//  · drag the top edge of a panel to adjust its height
//  · the stack scrolls when panels exceed the space, so the
//    watchlist (search panel) above shrinks as depth grows
//  · quantity renders in LOTS when the instrument has a lot size,
//    otherwise raw shares
// ------------------------------------------------------------

const DEPTH_MIN_H = 96
const DEPTH_MAX_H = 460

export function DepthStack({ ws }: { ws: WorkspaceCfg }) {
  const patchWs = useTerminal(s => s.patchWs)
  const selectedSymbol = useTerminal(s => s.selectedSymbol)
  // persisted cfg; fall back to a single panel for the workspace symbol
  const panels: DepthPanelCfg[] = ws.depthPanels ?? defaultDepthPanels(ws.symbol)

  const setPanels = (next: DepthPanelCfg[]) => patchWs(ws.id, { depthPanels: next })

  const addPanel = () => {
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id) ?? ws
    const sym = selectedSymbol || ws.symbol
    const { patch, error } = addDepthPanelTo(cur, sym)
    if (error) { toast.info(error); return }
    setPanels(patch.depthPanels!)
  }

  const removePanel = (id: string) => setPanels(panels.filter(p => p.id !== id))

  const resizePanel = (id: string, height: number) =>
    setPanels(panels.map(p => (p.id === id ? { ...p, height } : p)))

  return (
    <div className="border-t border-border flex flex-col min-h-0 max-h-[72%] shrink-0">
      <div className="flex items-center gap-1 px-2 py-1 bg-card/30 shrink-0">
        <Layers className="h-3 w-3 text-muted-foreground" />
        <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Depth</span>
        <span className="text-[9px] text-muted-foreground">{panels.length}</span>
        <div className="flex-1" />
        <button
          onClick={addPanel}
          title={`Add depth panel for ${selectedSymbol || ws.symbol}`}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
      <div className="overflow-y-auto min-h-0">
        {panels.map(p => (
          <DepthPanel key={p.id} cfg={p} onRemove={() => removePanel(p.id)} onResize={h => resizePanel(p.id, h)} />
        ))}
      </div>
    </div>
  )
}

function DepthPanel({ cfg, onRemove, onResize }: {
  cfg: DepthPanelCfg
  onRemove: () => void
  onResize: (height: number) => void
}) {
  const symbol = cfg.symbol
  const [height, setHeight] = useState(cfg.height)
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof api.quote>> | null>(null)
  const [ltp, setLtp] = useState(0)
  const [prev, setPrev] = useState(0)
  const dragRef = useRef<{ startY: number; startH: number; h: number } | null>(null)

  useEffect(() => setHeight(cfg.height), [cfg.height])

  useEffect(() => {
    let dead = false
    const pull = async () => {
      try {
        const q = await api.quote(symbol)
        if (!dead) setQuote(q)
      } catch { /* ignore */ }
    }
    pull()
    const iv = setInterval(pull, 4000)
    return () => { dead = true; clearInterval(iv) }
  }, [symbol])

  useEffect(() => onTicks(map => {
    const t = map[symbol]
    if (t) { setLtp(t.ltp); setPrev(t.prevClose) }
  }), [symbol])

  // drag the top edge to resize (local during drag, committed on release)
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height, h: height }
    const move = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const next = Math.max(DEPTH_MIN_H, Math.min(DEPTH_MAX_H, Math.round(d.startH + (d.startY - ev.clientY))))
      d.h = next
      setHeight(next)
    }
    const up = () => {
      const d = dragRef.current
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (d && d.h !== d.startH) onResize(d.h)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const chg = ltp && prev ? ltp - prev : 0
  const chgPct = ltp && prev ? (chg / prev) * 100 : 0
  const up = chg >= 0
  const lotSize = quote?.lotSize ?? 1
  const inLots = lotSize > 1
  const qtyLabel = inLots ? 'LOT' : 'QTY'
  const fmtQty = (qty: number) => (inLots ? (qty / lotSize).toFixed(inLots && qty / lotSize < 10 ? 1 : 0) : String(qty))

  return (
    <div className="border-b border-border/60" style={{ height }} data-depth-panel={symbol}>
      {/* resize handle (top edge) */}
      <div
        onMouseDown={startResize}
        title="Drag to resize this depth panel"
        className="h-2 flex items-center justify-center cursor-row-resize text-muted-foreground/40 hover:text-muted-foreground hover:bg-secondary/40"
      >
        <GripHorizontal className="h-2.5 w-2.5" />
      </div>
      <div className="px-2 pb-1.5 space-y-1.5 flex flex-col h-[calc(100%-8px)]">
        <div className="flex items-center justify-between shrink-0">
          <div className="text-[11px] font-semibold truncate">
            {symbol}
            {inLots && <span className="ml-1 text-[8px] text-muted-foreground font-normal">L{lotSize}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="text-right">
              <div className={`text-xs font-bold tabular leading-none ${up ? 'term-up' : 'term-down'}`}>{ltp ? ltp.toFixed(2) : quote?.ltp?.toFixed(2) ?? '—'}</div>
              <div className={`text-[9px] tabular ${up ? 'term-up' : 'term-down'}`}>
                {ltp ? `${up ? '+' : ''}${chg.toFixed(2)} (${chgPct.toFixed(2)}%)` : ''}
              </div>
            </div>
            <button onClick={onRemove} title="Remove this depth panel" className="p-0.5 rounded text-muted-foreground hover:text-[#ff4d5e]">
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1 text-[10px] tabular shrink-0">
          <div className="bg-up rounded px-1.5 py-0.5 flex justify-between">
            <span className="text-muted-foreground">Bid</span>
            <span className="term-up">{quote?.bid?.toFixed(2) ?? '—'}</span>
          </div>
          <div className="bg-down rounded px-1.5 py-0.5 flex justify-between">
            <span className="text-muted-foreground">Ask</span>
            <span className="term-down">{quote?.ask?.toFixed(2) ?? '—'}</span>
          </div>
        </div>
        {quote?.depth && (
          <div className="grid grid-cols-2 gap-x-3 text-[10px] tabular flex-1 min-h-0 overflow-hidden">
            <div>
              <div className="text-muted-foreground text-[9px] mb-0.5 flex justify-between"><span>BID</span><span>{qtyLabel}</span></div>
              {quote.depth.buys.slice(0, 5).map((b, i) => (
                <div key={i} className="flex justify-between py-[1px]">
                  <span className="term-up">{b.price.toFixed(2)}</span>
                  <span className="text-muted-foreground">{fmtQty(b.qty)}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-muted-foreground text-[9px] mb-0.5 flex justify-between"><span>ASK</span><span>{qtyLabel}</span></div>
              {quote.depth.sells.slice(0, 5).map((b, i) => (
                <div key={i} className="flex justify-between py-[1px]">
                  <span className="term-down">{b.price.toFixed(2)}</span>
                  <span className="text-muted-foreground">{fmtQty(b.qty)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
