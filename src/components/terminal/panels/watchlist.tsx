'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { GripHorizontal, Layers, Plus, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { api, type SymbolRow } from '../lib/client-api'
import { useTerminal, defaultDepthPanels, addDepthPanelTo, type DepthPanelCfg, type WorkspaceCfg } from '../lib/store'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'
import type { Tick } from '@/lib/types'

export function Watchlist() {
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [ticks, setTicks] = useState<Record<string, Tick>>({})
  const selectedSymbol = useTerminal(s => s.selectedSymbol)
  const setSymbol = useTerminal(s => s.setSymbol)

  const { data } = useQuery({
    queryKey: ['symbols', q, type],
    queryFn: () => api.symbols(q, type),
    refetchInterval: 60_000,
  })

  const symbols = useMemo(() => {
    const list = data?.symbols ?? []
    // keep indices/eq/futures first, options after
    return [...list].sort((a, b) => {
      const rank = (r: SymbolRow) => (r.instrumentType === 'INDEX' ? 0 : r.instrumentType === 'EQ' ? 1 : r.instrumentType === 'FUT' ? 2 : 3)
      return rank(a) - rank(b) || a.symbol.localeCompare(b.symbol)
    })
  }, [data])

  const visible = symbols.slice(0, 60)
  const visibleKey = visible.map(s => s.symbol).join(',')
  useEffect(() => {
    const list = visibleKey ? visibleKey.split(',') : []
    subscribeTicks(list)
    return () => unsubscribeTicks(list)
  }, [visibleKey])

  useEffect(() => onTicks(setTicks), [])

  return (
    <div className="flex h-full flex-col">
      <div className="p-2 space-y-1.5 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={e => setQ(e.target.value.toUpperCase())}
            placeholder="Search master contracts…"
            className="h-8 pl-7 text-xs bg-secondary/60"
          />
        </div>
        <div className="flex gap-1">
          {[
            ['', 'All'],
            ['INDEX', 'Index'],
            ['EQ', 'Equity'],
            ['FUT', 'Fut'],
            ['CE', 'CE'],
            ['PE', 'PE'],
          ].map(([v, l]) => (
            <button
              key={v}
              onClick={() => setType(v)}
              className={`px-1.5 py-0.5 text-[10px] rounded ${type === v ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {visible.map(s => {
          const t = ticks[s.symbol]
          const ltp = t?.ltp ?? s.basePrice ?? 0
          const chg = t && t.prevClose ? ((t.ltp - t.prevClose) / t.prevClose) * 100 : 0
          const up = chg >= 0
          const active = s.symbol === selectedSymbol
          return (
            <button
              key={s.id}
              onClick={() => setSymbol(s.symbol)}
              className={`w-full px-2 py-1.5 flex items-center justify-between text-left border-l-2 transition-colors ${
                active ? 'border-primary bg-accent' : 'border-transparent hover:bg-secondary/50'
              }`}
            >
              <div className="min-w-0">
                <div className="text-[11px] font-medium truncate">{s.symbol}</div>
                <div className="text-[9px] text-muted-foreground">
                  {s.exchange} · {s.instrumentType}{s.instrumentType === 'EQ' ? ` · L${s.lotSize}` : ''}
                </div>
              </div>
              <div className="text-right tabular">
                <div className={`text-[11px] ${t ? (t.ltp >= (t.prevClose || t.ltp) ? 'term-up' : 'term-down') : ''}`}>
                  {ltp ? ltp.toFixed(2) : '—'}
                </div>
                <div className={`text-[9px] ${up ? 'term-up' : 'term-down'}`}>
                  {t ? `${up ? '+' : ''}${chg.toFixed(2)}%` : '—'}
                </div>
              </div>
            </button>
          )
        })}
        {symbols.length === 0 && (
          <div className="p-4 text-center text-[11px] text-muted-foreground">No symbols. Sync master contracts in Admin.</div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Depth panel stack (bottom-left dock).
// N market-depth panels stacked top-to-bottom:
//  · [+] adds a depth panel for the currently selected symbol
//  · X removes a panel
//  · drag the top edge of a panel to adjust its height
//  · the stack scrolls when panels exceed the space, so the
//    watchlist (search panel) above shrinks as depth grows
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
          <div className="text-[11px] font-semibold truncate">{symbol}</div>
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
              <div className="text-muted-foreground text-[9px] mb-0.5 flex justify-between"><span>BID</span><span>QTY</span></div>
              {quote.depth.buys.slice(0, 5).map((b, i) => (
                <div key={i} className="flex justify-between py-[1px]">
                  <span className="term-up">{b.price.toFixed(2)}</span>
                  <span className="text-muted-foreground">{b.qty}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-muted-foreground text-[9px] mb-0.5 flex justify-between"><span>ASK</span><span>QTY</span></div>
              {quote.depth.sells.slice(0, 5).map((b, i) => (
                <div key={i} className="flex justify-between py-[1px]">
                  <span className="term-down">{b.price.toFixed(2)}</span>
                  <span className="text-muted-foreground">{b.qty}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
