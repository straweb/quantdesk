'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { api, type SymbolRow } from '../lib/client-api'
import { useTerminal } from '../lib/store'
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

export function MarketDepth() {
  const symbol = useTerminal(s => s.selectedSymbol)
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof api.quote>> | null>(null)
  const [ltp, setLtp] = useState(0)
  const [prev, setPrev] = useState(0)

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

  const chg = ltp && prev ? ltp - prev : 0
  const chgPct = ltp && prev ? (chg / prev) * 100 : 0
  const up = chg >= 0

  return (
    <div className="p-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold">{symbol}</div>
        <div className="text-right">
          <div className={`text-sm font-bold tabular ${up ? 'term-up' : 'term-down'}`}>{ltp ? ltp.toFixed(2) : quote?.ltp?.toFixed(2) ?? '—'}</div>
          <div className={`text-[9px] tabular ${up ? 'term-up' : 'term-down'}`}>
            {ltp ? `${up ? '+' : ''}${chg.toFixed(2)} (${chgPct.toFixed(2)}%)` : ''}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 text-[10px] tabular">
        <div className="bg-up rounded px-1.5 py-1 flex justify-between">
          <span className="text-muted-foreground">Bid</span>
          <span className="term-up">{quote?.bid?.toFixed(2) ?? '—'}</span>
        </div>
        <div className="bg-down rounded px-1.5 py-1 flex justify-between">
          <span className="text-muted-foreground">Ask</span>
          <span className="term-down">{quote?.ask?.toFixed(2) ?? '—'}</span>
        </div>
      </div>
      {quote?.depth && (
        <div className="grid grid-cols-2 gap-x-3 text-[10px] tabular">
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
  )
}
