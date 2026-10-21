'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Pencil, Plus, Power, Trash2, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { api, fmtMoney } from '../lib/client-api'
import type { ChainStrikeRow, OptionQuoteCell } from '../lib/client-api'
import { useTerminal, defaultStrikes, type StrikesCfg, type StrikeRowCfg, type WorkspaceCfg } from '../lib/store'

// ============================================================
// F&O Strikes panel (right side panel tab).
// - Dynamic strike add: CE/PE ATM +/- 1..5 one-click buttons +
//   specific-strike input (auto-creates missing contracts)
// - Strike rows: enabled toggle, alloc %, ATM offset, LTP,
//   day high/low, Buy / Sell / Exit, edit open position
// - Quick deploy bar: Deploy CE, Deploy PE, Cancel CE, PE Swap
//   (orders sized as % of each account's usable capital —
//   house capital rules apply per leg via the order router)
// ============================================================

const OFFSETS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5] as const

export function StrikesPanel({ ws }: { ws: WorkspaceCfg }) {
  const patchWs = useTerminal(s => s.patchWs)
  const st: StrikesCfg = useMemo(() => ws.strikes ?? defaultStrikes(), [ws])

  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const underlyings = undData?.underlyings ?? []

  // auto-bind the workspace's F&O symbol on first open
  useEffect(() => {
    if (!st.underlying && underlyings.some(u => u.underlying === ws.symbol)) {
      patchWs(ws.id, { strikes: { ...st, underlying: ws.symbol } })
    }
  }, [st.underlying, underlyings, ws.symbol, ws.id, patchWs]) // eslint-disable-line react-hooks/exhaustive-deps

  const underlying = st.underlying
  const strikesParam = useMemo(() => [...new Set(st.rows.map(r => r.strike))].sort((a, b) => a - b), [st.rows])

  const { data: chainData, refetch: refetchChain } = useQuery({
    queryKey: ['optionChain', underlying, st.expiry, strikesParam.join(',')],
    queryFn: () => api.optionChain(underlying!, st.expiry, strikesParam),
    enabled: !!underlying,
    refetchInterval: 1000,
  })
  const meta = chainData?.meta ?? null
  const rowByStrike = useMemo(() => {
    const m = new Map<number, ChainStrikeRow>()
    for (const r of chainData?.rows ?? []) m.set(r.strike, r)
    return m
  }, [chainData])

  const { data: posData } = useQuery({ queryKey: ['positions'], queryFn: () => api.positions(), refetchInterval: 2000 })
  const posBySymbol = useMemo(() => {
    const m = new Map<string, { netQty: number; avgPrice: number; unrealizedPnl: number }>()
    for (const p of posData?.bySymbol ?? []) m.set(p.symbol, p)
    return m
  }, [posData])

  const [specific, setSpecific] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const setStrikes = (next: Partial<StrikesCfg>) => patchWs(ws.id, { strikes: { ...st, ...next } })
  const setRow = (id: string, patch: Partial<StrikeRowCfg>) =>
    setStrikes({ rows: st.rows.map(r => (r.id === id ? { ...r, ...patch } : r)) })
  const removeRow = (id: string) => setStrikes({ rows: st.rows.filter(r => r.id !== id) })

  const addStrike = async (strike: number, type: 'CE' | 'PE') => {
    if (!underlying) { toast.error('Pick an F&O underlying first'); return }
    const id = `${strike}:${type}`
    // read fresh store state (consecutive adds must not clobber each other)
    const cur = useTerminal.getState().workspaces.find(w => w.id === ws.id)?.strikes ?? st
    if (cur.rows.some(r => r.id === id)) { toast.info(`${strike} ${type} already in list`); return }
    try {
      const r = await api.ensureStrike(underlying, strike, st.expiry)
      if (r.created > 0) toast.success(`Contracts ready — ${r.symbols.join(', ')}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create contracts')
      return
    }
    patchWs(ws.id, { strikes: { ...cur, rows: [...cur.rows, { id, strike, type, enabled: true, allocPct: st.allocPct }] } })
    setTimeout(() => refetchChain(), 150)
  }

  const addSpecific = async () => {
    const raw = Number(specific)
    if (!underlying || !Number.isFinite(raw) || raw <= 0) { toast.error('Enter a valid strike'); return }
    const step = meta?.step ?? 50
    const snapped = Math.round(raw / step) * step
    if (snapped !== raw) toast.info(`Snapped ${raw} → ${snapped} (step ${step})`)
    setSpecific('')
    await Promise.all([addStrike(snapped, 'CE'), addStrike(snapped, 'PE')])
  }

  // --- order helpers ---
  const rowsFor = (type: 'CE' | 'PE') => st.rows.filter(r => r.type === type && r.enabled)

  const cellFor = (row: StrikeRowCfg): OptionQuoteCell | null => {
    const c = rowByStrike.get(row.strike)
    if (!c) return null
    return row.type === 'CE' ? c.ce : c.pe
  }

  const deploy = async (type: 'CE' | 'PE') => {
    const rows = rowsFor(type)
    if (rows.length === 0) { toast.error(`No enabled ${type} strikes`); return }
    setBusy(true)
    let filled = 0, failed = 0
    for (const row of rows) {
      const cell = cellFor(row)
      if (!cell?.exists) { failed++; continue }
      try {
        const res = await api.placeOrder({
          symbol: cell.symbol, exchange: 'NFO', side: 'BUY', qty: 0,
          orderType: 'MARKET', productType: 'MIS', source: 'MANUAL', capitalPct: row.allocPct,
        })
        filled += res.legs.filter(l => l.status === 'FILLED').length
        if (res.status === 'FAILED') failed++
      } catch { failed++ }
    }
    setBusy(false)
    filled > 0
      ? toast.success(`Deploy ${type} — ${filled} legs filled${failed ? `, ${failed} skipped` : ''}`)
      : toast.error(`Deploy ${type} failed — ${failed} strikes skipped`)
  }

  const cancelType = async (type: 'CE' | 'PE') => {
    const syms = rowsFor(type).map(r => cellFor(r)?.symbol).filter((s): s is string => !!s)
    if (syms.length === 0) { toast.error(`No enabled ${type} strikes`); return }
    try {
      const r = await api.cancelAll(syms)
      r.cancelled > 0 ? toast.success(`Cancelled ${r.cancelled} pending ${type} orders`) : toast.info(`No pending ${type} orders`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Cancel failed') }
  }

  const peSwap = async () => {
    const ceRows = rowsFor('CE')
    const ceSyms = ceRows.map(r => cellFor(r)?.symbol).filter((s): s is string => !!s)
    setBusy(true)
    try {
      if (ceSyms.length > 0) {
        const so = await api.squareOffAll(false, ceSyms)
        toast.success(`CE squared off — ${so.filledLegs} legs`)
      }
      // flip on: deploy PE on enabled PE rows (auto-add ATM PE if none listed)
      let peRows = rowsFor('PE')
      if (peRows.length === 0) {
        if (meta) {
          await addStrike(meta.atm, 'PE')
          await new Promise(r => setTimeout(r, 500))
          const ws2 = useTerminal.getState().workspaces.find(w => w.id === ws.id)
          peRows = (ws2?.strikes?.rows ?? []).filter(r => r.type === 'PE' && r.enabled)
        }
      }
      let filled = 0, failed = 0
      const allStrikes = [...new Set(st.rows.map(r => r.strike))]
      const cd = await api.optionChain(underlying!, st.expiry, allStrikes)
      const fresh = new Map<number, ChainStrikeRow>(cd.rows.map(r => [r.strike, r]))
      for (const row of peRows) {
        const c = fresh.get(row.strike)
        const cell = row.type === 'PE' ? c?.pe : c?.ce
        if (!cell?.exists) { failed++; continue }
        try {
          const res = await api.placeOrder({
            symbol: cell.symbol, exchange: 'NFO', side: 'BUY', qty: 0,
            orderType: 'MARKET', productType: 'MIS', source: 'MANUAL', capitalPct: row.allocPct,
          })
          filled += res.legs.filter(l => l.status === 'FILLED').length
          if (res.status === 'FAILED') failed++
        } catch { failed++ }
      }
      toast.success(`PE Swap complete — ${filled} legs filled${failed ? `, ${failed} skipped` : ''}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'PE Swap failed')
    } finally { setBusy(false) }
  }

  const rowBuy = async (row: StrikeRowCfg) => {
    const cell = cellFor(row)
    if (!cell?.exists) { toast.error('Quote unavailable'); return }
    try {
      const res = await api.placeOrder({
        symbol: cell.symbol, exchange: 'NFO', side: 'BUY', qty: 0,
        orderType: 'MARKET', productType: 'MIS', source: 'MANUAL', capitalPct: row.allocPct,
      })
      res.status === 'FAILED' ? toast.error(`BUY failed — ${res.message}`) : toast.success(`BUY ${row.strike} ${row.type} — ${res.legs.filter(l => l.status === 'FILLED').length}/${res.legs.length} legs`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Order failed') }
  }

  const rowSell = async (row: StrikeRowCfg) => {
    const cell = cellFor(row)
    if (!cell?.exists) { toast.error('Quote unavailable'); return }
    const pos = posBySymbol.get(cell.symbol)
    if (pos && pos.netQty > 0) {
      // long position -> Sell means exit
      const so = await api.squareOffAll(false, [cell.symbol])
      toast.success(`Exited long — ${so.filledLegs} legs`)
      return
    }
    try {
      const res = await api.placeOrder({
        symbol: cell.symbol, exchange: 'NFO', side: 'SELL', qty: 0,
        orderType: 'MARKET', productType: 'MIS', source: 'MANUAL', capitalPct: row.allocPct,
      })
      res.status === 'FAILED' ? toast.error(`SELL failed — ${res.message}`) : toast.success(`SELL ${row.strike} ${row.type} — ${res.legs.filter(l => l.status === 'FILLED').length}/${res.legs.length} legs`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Order failed') }
  }

  const rowExit = async (row: StrikeRowCfg) => {
    const cell = cellFor(row)
    if (!cell?.exists) { toast.error('Quote unavailable'); return }
    const pos = posBySymbol.get(cell.symbol)
    if (!pos || pos.netQty === 0) { toast.info('No open position'); return }
    try {
      const so = await api.squareOffAll(false, [cell.symbol])
      so.orders > 0 ? toast.success(`Exit ${row.strike} ${row.type} — ${so.filledLegs} legs`) : toast.info('Nothing to exit')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Exit failed') }
  }

  const sortedRows = useMemo(() => [...st.rows].sort((a, b) => a.strike - b.strike || (a.type === 'CE' ? -1 : 1)), [st.rows])

  return (
    <div className="flex h-full flex-col text-[11px]">
      {/* underlying + expiry selectors */}
      <div className="p-2 space-y-1.5 border-b border-border">
        <div className="flex gap-1">
          <select
            value={underlying ?? ''}
            onChange={e => setStrikes({ underlying: e.target.value || null })}
            className="h-7 flex-1 rounded bg-secondary/60 px-1.5 text-[11px] outline-none"
          >
            <option value="">Select F&O underlying…</option>
            {underlyings.map(u => (
              <option key={u.underlying} value={u.underlying}>{u.underlying} · L{u.lotSize}</option>
            ))}
          </select>
          <select
            value={st.expiry ?? ''}
            onChange={e => setStrikes({ expiry: e.target.value || null })}
            disabled={!meta}
            className="h-7 w-[104px] rounded bg-secondary/60 px-1.5 text-[10px] outline-none"
          >
            <option value="">Nearest</option>
            {(meta?.expiries ?? []).map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <div className="flex items-center justify-between tabular text-[10px]">
          <span className="text-muted-foreground">
            Spot <b className={meta && meta.spot >= meta.prevClose ? 'term-up' : 'term-down'}>{meta ? fmtMoney(meta.spot) : '—'}</b>
          </span>
          <span className="text-muted-foreground">ATM <b className="text-foreground">{meta?.atm ?? '—'}</b></span>
          <span className="text-muted-foreground">step {meta?.step ?? '—'}</span>
          <span className="text-muted-foreground">lot {meta?.lotSize ?? '—'}</span>
        </div>

        {/* ATM offset quick-add */}
        {meta && (
          <div className="space-y-1 pt-0.5">
            {(['CE', 'PE'] as const).map(t => (
              <div key={t} className="flex items-center gap-0.5">
                <span className={`w-5 text-[9px] font-bold ${t === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{t}</span>
                {OFFSETS.map(o => {
                  const strike = meta.atm + o * meta.step
                  const added = st.rows.some(r => r.id === `${strike}:${t}`)
                  return (
                    <button
                      key={o}
                      onClick={() => addStrike(strike, t)}
                      title={`${t} ${strike}${o === 0 ? ' (ATM)' : ` (${o > 0 ? 'OTM' : 'ITM'} ${Math.abs(o)})`}`}
                      className={`flex-1 px-0 py-0.5 rounded text-[9px] tabular transition-colors ${
                        added ? 'bg-primary/25 text-foreground' : 'bg-secondary/70 text-muted-foreground hover:text-foreground hover:bg-accent'
                      }`}
                    >{o === 0 ? 'ATM' : o > 0 ? `+${o}` : o}</button>
                  )
                })}
              </div>
            ))}
            <div className="flex gap-1 pt-0.5">
              <Input
                value={specific}
                onChange={e => setSpecific(e.target.value.replace(/[^0-9.]/g, ''))}
                onKeyDown={e => e.key === 'Enter' && addSpecific()}
                placeholder="Specific strike…"
                className="h-6 flex-1 text-[10px] bg-secondary/60"
              />
              <Button size="sm" variant="secondary" className="h-6 px-2 text-[10px]" onClick={addSpecific} disabled={!specific}>
                <Plus className="h-3 w-3 mr-0.5" /> Add CE+PE
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* strike rows */}
      <div className="flex-1 overflow-y-auto">
        {st.rows.length === 0 && (
          <div className="p-4 text-center text-[10px] text-muted-foreground leading-relaxed">
            Add strikes with the CE/PE ATM ± buttons above,<br />or enter a specific strike.
          </div>
        )}
        {sortedRows.map(row => {
          const cell = cellFor(row)
          const chainRow = rowByStrike.get(row.strike)
          const offsetLabel = chainRow ? chainRow.offset : null
          const pos = cell?.exists ? posBySymbol.get(cell.symbol) : undefined
          const lots = pos ? Math.abs(pos.netQty) / (meta?.lotSize || 1) : 0
          const isCE = row.type === 'CE'
          return (
            <div key={row.id} className={`border-b border-border/60 ${expanded === row.id ? 'bg-accent/40' : ''}`}>
              <div className="flex items-center gap-1 px-1.5 py-1">
                <button
                  onClick={() => setRow(row.id, { enabled: !row.enabled })}
                  title={row.enabled ? 'Enabled for deploy' : 'Disabled'}
                  className={`h-3.5 w-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
                    row.enabled ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                  }`}
                >
                  {row.enabled && <Power className="h-2.5 w-2.5 text-primary-foreground" />}
                </button>
                <div className="w-14 shrink-0 tabular font-semibold">{row.strike}</div>
                <span className={`w-7 shrink-0 text-[9px] font-bold ${isCE ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{row.type}</span>
                <span className="w-8 shrink-0 text-[9px] text-muted-foreground" title="ATM offset">
                  {offsetLabel == null ? '—' : offsetLabel === 0 ? 'ATM' : offsetLabel > 0 ? `+${offsetLabel}` : String(offsetLabel)}
                </span>
                <div className="flex-1 min-w-0 text-right pr-1">
                  <div className={`tabular ${cell && cell.ltp >= cell.prevClose ? 'term-up' : 'term-down'}`}>
                    {cell?.exists ? fmtMoney(cell.ltp) : '—'}
                  </div>
                  <div className="tabular text-[9px] text-muted-foreground">
                    {cell?.exists ? `${fmtMoney(cell.high, 1)}/${fmtMoney(cell.low, 1)}` : 'H/L —'}
                  </div>
                </div>
                {lots > 0 && (
                  <span className={`text-[8px] px-1 rounded ${pos && pos.netQty > 0 ? 'bg-up text-[#00c896]' : 'bg-down text-[#ff4d5e]'}`} title={`${lots} lots @ ${fmtMoney(pos!.avgPrice)}`}>
                    {pos && pos.netQty > 0 ? 'L' : 'S'}{lots}
                  </span>
                )}
                <div className="flex gap-0.5 shrink-0">
                  <button onClick={() => rowBuy(row)} className="px-1.5 py-0.5 rounded bg-up text-[#00c896] hover:brightness-125 text-[9px] font-bold">B</button>
                  <button onClick={() => rowSell(row)} className="px-1.5 py-0.5 rounded bg-down text-[#ff4d5e] hover:brightness-125 text-[9px] font-bold">S</button>
                  <button onClick={() => rowExit(row)} className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground text-[9px] font-bold">X</button>
                  <button
                    onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                    className={`p-0.5 rounded ${expanded === row.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    title="Edit open position"
                  >
                    <Pencil className="h-2.5 w-2.5" />
                  </button>
                </div>
              </div>

              {expanded === row.id && (
                <StrikeRowEditor
                  row={row}
                  cell={cell}
                  lots={lots}
                  pos={pos ?? null}
                  lotSize={meta?.lotSize ?? 1}
                  onApply={async (deltaLots) => {
                    const cell2 = cellFor(row)
                    if (!cell2?.exists) return
                    if (deltaLots > 0) {
                      const res = await api.placeOrder({
                        symbol: cell2.symbol, exchange: 'NFO', side: 'BUY', qty: deltaLots,
                        orderType: 'MARKET', productType: 'MIS', source: 'MANUAL',
                      })
                      res.status === 'FAILED' ? toast.error(`Add failed — ${res.message}`) : toast.success(`+${deltaLots} lot(s)/leg — ${res.legs.filter(l => l.status === 'FILLED').length} legs`)
                    } else if (deltaLots < 0) {
                      await api.placeOrder({
                        symbol: cell2.symbol, exchange: 'NFO', side: 'SELL', qty: Math.abs(deltaLots),
                        orderType: 'MARKET', productType: 'MIS', source: 'MANUAL', reduceOnly: true,
                      })
                      toast.success(`${deltaLots} lot(s)/leg exited`)
                    }
                  }}
                  onExit={async () => {
                    const cell2 = cellFor(row)
                    if (!cell2) return
                    const so = await api.squareOffAll(false, [cell2.symbol])
                    toast.success(`Exited — ${so.filledLegs} legs`)
                  }}
                  onRemove={() => { removeRow(row.id); setExpanded(null) }}
                  allocPct={row.allocPct}
                  onAlloc={v => setRow(row.id, { allocPct: v })}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* quick deploy bar */}
      <div className="border-t border-border p-2 space-y-1.5 bg-card/40">
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">Alloc %/strike</span>
          <Input
            value={st.allocPct}
            onChange={e => setStrikes({ allocPct: Math.max(0.1, Math.min(100, Number(e.target.value.replace(/[^0-9.]/g, '')) || 1)) })}
            className="h-6 w-14 text-[10px] bg-secondary/60"
          />
          <span className="text-[9px] text-muted-foreground">% of each account's usable capital per order</span>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button size="sm" className="h-7 text-[10px] bg-up text-[#00c896] hover:bg-[#00c896] hover:text-black" disabled={busy || !underlying} onClick={() => deploy('CE')}>
            Deploy CE
          </Button>
          <Button size="sm" className="h-7 text-[10px] bg-down text-[#ff4d5e] hover:bg-[#ff4d5e] hover:text-black" disabled={busy || !underlying} onClick={() => deploy('PE')}>
            Deploy PE
          </Button>
          <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={busy || !underlying} onClick={() => cancelType('CE')}>
            Cancel CE
          </Button>
          <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={busy || !underlying} onClick={peSwap}>
            PE Swap
          </Button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Inline "edit open position" editor
// ------------------------------------------------------------
function StrikeRowEditor({ row, cell, lots, pos, lotSize, onApply, onExit, onRemove, allocPct, onAlloc }: {
  row: StrikeRowCfg
  cell: OptionQuoteCell | null
  lots: number
  pos: { netQty: number; avgPrice: number; unrealizedPnl: number } | null
  lotSize: number
  onApply: (deltaLots: number) => Promise<void>
  onExit: () => Promise<void>
  onRemove: () => void
  allocPct: number
  onAlloc: (v: number) => void
}) {
  const [delta, setDelta] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setDelta(''), [lots])

  return (
    <div className="px-2 pb-2 pt-1 space-y-1.5 border-t border-border/40 bg-secondary/20">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">Position — {cell?.symbol ?? row.type}</span>
        <span className="tabular">
          {pos ? (
            <>
              {pos.netQty > 0 ? 'LONG' : 'SHORT'} {lots} lot(s) @ {fmtMoney(pos.avgPrice)} ·{' '}
              <b className={pos.unrealizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtMoney(pos.unrealizedPnl)}</b>
            </>
          ) : 'flat'}
        </span>
      </div>
      <div className="flex items-center gap-1 text-[10px]">
        <span className="text-muted-foreground">Δ Lots /leg</span>
        <Input
          value={delta}
          onChange={e => setDelta(e.target.value.replace(/[^0-9-]/g, ''))}
          placeholder="+2 / -1"
          className="h-6 w-16 text-[10px] bg-secondary/60"
        />
        <Button
          size="sm" variant="secondary" className="h-6 px-2 text-[10px]" disabled={busy || !delta || delta === '-' || delta === '+0'}
          onClick={async () => { setBusy(true); await onApply(Number(delta)); setBusy(false) }}
        >Apply</Button>
        <span className="text-[9px] text-muted-foreground">+ buys, − exits (per enabled account) · now {lots} lot(s) agg</span>
        <div className="flex-1" />
        <Button
          size="sm" variant="secondary" className="h-6 px-2 text-[10px] text-[#ff4d5e]" disabled={busy || !pos}
          onClick={async () => { setBusy(true); await onExit(); setBusy(false) }}
        >Exit full</Button>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-[#ff4d5e]" onClick={onRemove}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      <div className="flex items-center gap-1 text-[10px]">
        <span className="text-muted-foreground">Alloc %</span>
        <Input
          value={allocPct}
          onChange={e => onAlloc(Math.max(0.1, Math.min(100, Number(e.target.value.replace(/[^0-9.]/g, '')) || 1)))}
          className="h-6 w-14 text-[10px] bg-secondary/60"
        />
        <span className="text-[9px] text-muted-foreground">lot {lotSize} · orders fan out to all enabled accounts</span>
      </div>
    </div>
  )
}
