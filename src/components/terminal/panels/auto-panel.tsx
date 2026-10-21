'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bot, Clock3, Gauge, Layers, Trash2, Webhook } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, fmtTime } from '../lib/client-api'
import type { WorkspaceCfg } from '../lib/store'

// ============================================================
// Auto bot (right dock "Auto" tab) — rule builder v3.
// COMPOUND triggers: enable any mix of
//   · TIME     — at HH:MM:SS IST (seconds precision)
//   · RANGE    — index price inside [lo, hi]
//   · PREMIUM  — the option's own price ≤ x / in lo–hi / ≥ x
//   (delta/gamma move the premium even when the index is low —
//   the premium condition is checked per strike at fire time)
// ALL enabled conditions must be true at the same 250ms tick.
// Time rules wait inside a 5-min grace window until the other
// conditions align (2s when time is the only condition).
// Actions: BUY / SELL / DEPLOY side list / CANCEL side orders.
// Strikes: ATM ± 1..5 button row, or a picked set from the
// workspace strike rows (each with its own alloc %).
// Optional order legs (any subset): entry LIMIT ₹, SL, TGT.
// Rules run server-side — they fire even when the terminal is closed.
// ============================================================

type Action = 'BUY' | 'SELL' | 'DEPLOY' | 'CANCEL'
type PremiumMode = 'LTE' | 'RANGE' | 'GTE'

export function AutoPanel({ ws }: { ws: WorkspaceCfg }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['autorules'], queryFn: () => api.autoRules(), refetchInterval: 3000 })
  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const unds = undData?.underlyings ?? []
  const rules = data?.rules ?? []
  const defaultUnderlying = ws.strikes?.underlying ?? (unds.some(u => u.underlying === ws.symbol) ? ws.symbol : unds[0]?.underlying ?? '')

  // ---- conditions (any mix — at least one) ----
  const [useTime, setUseTime] = useState(true)
  const [useRange, setUseRange] = useState(false)
  const [usePremium, setUsePremium] = useState(false)
  const [time, setTime] = useState('09:30:00')
  const [lo, setLo] = useState('')
  const [hi, setHi] = useState('')
  const [pmode, setPmode] = useState<PremiumMode>('LTE')
  const [pLo, setPLo] = useState('')
  const [pHi, setPHi] = useState('')

  // ---- action + strikes ----
  const [underlying, setUnderlying] = useState(defaultUnderlying)
  const [action, setAction] = useState<Action>('BUY')
  const [optType, setOptType] = useState<'CE' | 'PE'>('CE')
  const [offset, setOffset] = useState(0)
  const [allocPct, setAllocPct] = useState(100)
  const [entryPrice, setEntryPrice] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [target, setTarget] = useState('')
  const [pickStrikes, setPickStrikes] = useState(false)
  const [picked, setPicked] = useState<Record<string, number>>({}) // rowId -> allocPct
  const [repeatDaily, setRepeatDaily] = useState(true)
  const [busy, setBusy] = useState(false)

  const effUnderlying = underlying || defaultUnderlying
  const wsRows = (ws.strikes?.rows ?? []).filter(r => r.type === optType)

  const togglePicked = (id: string, strike: number, on: boolean) => {
    setPicked(p => {
      const next = { ...p }
      if (on) next[id] = next[id] ?? allocPct
      else delete next[id]
      return next
    })
    void strike
  }
  const pickedList = () =>
    Object.entries(picked).map(([id, allocPct]) => {
      const row = wsRows.find(r => r.id === id)
      return { strike: row?.strike ?? 0, type: optType, allocPct }
    }).filter(s => s.strike > 0)

  const create = async () => {
    if (!effUnderlying) { toast.error('Pick an F&O underlying'); return }
    if (!useTime && !useRange && !usePremium) { toast.error('Enable at least one condition (time / range / premium)'); return }
    if (useTime && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(time)) { toast.error('Time must be HH:MM or HH:MM:SS'); return }
    if (useRange && (!lo || !hi)) { toast.error('Enter the index range low and high'); return }
    if (usePremium && pmode === 'LTE' && !pHi) { toast.error('Premium ≤: enter the max price'); return }
    if (usePremium && pmode === 'GTE' && !pLo) { toast.error('Premium ≥: enter the min price'); return }
    if (usePremium && pmode === 'RANGE' && (!pLo || !pHi)) { toast.error('Premium range: enter lo and hi'); return }
    if (pickStrikes && Object.keys(picked).length === 0) { toast.error('Pick at least one strike (or switch to ATM mode)'); return }
    const strikes = pickStrikes ? pickedList() : undefined
    const condTxt = [
      useTime ? `@ ${time}` : null,
      useRange ? `idx ${lo}-${hi}` : null,
      usePremium ? `prem ${pmode === 'LTE' ? `≤${pHi}` : pmode === 'GTE' ? `≥${pLo}` : `${pLo}-${pHi}`}` : null,
    ].filter(Boolean).join(' + ')
    const name = `${action} ${optType}${strikes?.length ? ` ×${strikes.length}` : offset ? (offset > 0 ? ` +${offset}` : ` ${offset}`) : ' ATM'} ${condTxt}${entryPrice ? ` · e${entryPrice}` : ''}${stopLoss ? ` · sl${stopLoss}` : ''}${target ? ` · t${target}` : ''}`
    setBusy(true)
    try {
      await api.createAutoRule({
        name,
        underlying: effUnderlying,
        expiry: ws.strikes?.expiry ?? null,
        kind: 'COMPOUND', // server derives the final kind from enabled conditions
        time: useTime ? time : undefined,
        lo: useRange ? Number(lo) : undefined,
        hi: useRange ? Number(hi) : undefined,
        entryOp: usePremium ? pmode : undefined,
        entryLo: usePremium && (pmode === 'RANGE' || pmode === 'GTE') ? Number(pLo) : undefined,
        entryHi: usePremium && (pmode === 'RANGE' || pmode === 'LTE') ? Number(pHi) : undefined,
        action, optType, offset, allocPct,
        strikes,
        entryPrice: entryPrice ? Number(entryPrice) : undefined,
        stopLoss: stopLoss ? Number(stopLoss) : undefined,
        target: target ? Number(target) : undefined,
        enabled: true,
        repeatDaily,
      })
      await qc.invalidateQueries({ queryKey: ['autorules'] })
      toast.success('Auto rule armed')
      setLo(''); setHi(''); setPLo(''); setPHi('')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Create failed') }
    setBusy(false)
  }

  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api.patchAutoRule(id, { enabled })
      await qc.invalidateQueries({ queryKey: ['autorules'] })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const remove = async (id: string) => {
    try {
      await api.deleteAutoRule(id)
      await qc.invalidateQueries({ queryKey: ['autorules'] })
      toast.success('Rule deleted')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') }
  }

  const sel = 'h-6 rounded bg-secondary/60 px-1 text-[10px] outline-none'
  const btn = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[9px] font-bold ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary/70 text-muted-foreground hover:text-foreground'}`

  return (
    <div className="flex flex-col text-[11px]">
      {/* create form */}
      <div className="p-1.5 space-y-1.5 border-b border-border">
        <div className="flex items-center gap-1">
          <Bot className="h-3 w-3 text-primary" />
          <span className="text-[10px] font-bold uppercase tracking-wide">Auto bot</span>
          <div className="flex-1" />
          {/* condition chips — any mix */}
          <button onClick={() => setUseTime(!useTime)} className={btn(useTime)} title="At a specific time (HH:MM:SS IST)">Time</button>
          <button onClick={() => setUseRange(!useRange)} className={btn(useRange)} title="Index price inside a range">Range</button>
          <button onClick={() => setUsePremium(!usePremium)} className={btn(usePremium)} title="Option premium condition (delta/gamma aware)">Premium</button>
        </div>

        {/* condition inputs */}
        <div className="flex gap-1 items-center flex-wrap">
          <select value={effUnderlying} onChange={e => setUnderlying(e.target.value)} className={`${sel} min-w-0 flex-1`} title="Underlying">
            {unds.map(u => <option key={u.underlying} value={u.underlying}>{u.underlying}</option>)}
          </select>
          {useTime && (
            <Input
              value={time}
              onChange={e => setTime(e.target.value.replace(/[^0-9:]/g, ''))}
              placeholder="HH:MM:SS"
              className="h-6 w-[78px] text-[10px] tabular bg-secondary/60"
              title="Fires at this IST time (seconds precision). Combined rules wait up to 5 min for the other conditions."
            />
          )}
          {useRange && (
            <>
              <Input value={lo} onChange={e => setLo(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="idx lo" className="h-6 w-[54px] text-[10px] tabular bg-secondary/60" />
              <span className="text-muted-foreground text-[9px]">–</span>
              <Input value={hi} onChange={e => setHi(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="idx hi" className="h-6 w-[54px] text-[10px] tabular bg-secondary/60" />
            </>
          )}
        </div>
        {usePremium && (
          <div className="flex gap-1 items-center">
            <span className="text-[8px] text-muted-foreground uppercase tracking-wide shrink-0" title="Option premium condition — per strike at fire time">prem</span>
            {([['LTE', '≤'], ['RANGE', 'lo–hi'], ['GTE', '≥']] as [PremiumMode, string][]).map(([m, label]) => (
              <button key={m} onClick={() => setPmode(m)} className={btn(pmode === m)}>{label}</button>
            ))}
            {pmode === 'LTE' && (
              <Input value={pHi} onChange={e => setPHi(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="≤ ₹" className="h-6 w-[58px] text-[10px] tabular bg-secondary/60" />
            )}
            {pmode === 'GTE' && (
              <Input value={pLo} onChange={e => setPLo(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="≥ ₹" className="h-6 w-[58px] text-[10px] tabular bg-secondary/60" />
            )}
            {pmode === 'RANGE' && (
              <>
                <Input value={pLo} onChange={e => setPLo(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="lo" className="h-6 w-[50px] text-[10px] tabular bg-secondary/60" />
                <span className="text-muted-foreground text-[9px]">–</span>
                <Input value={pHi} onChange={e => setPHi(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="hi" className="h-6 w-[50px] text-[10px] tabular bg-secondary/60" />
              </>
            )}
          </div>
        )}

        {/* action + option side */}
        <div className="flex items-center gap-1">
          {(['BUY', 'SELL', 'DEPLOY', 'CANCEL'] as Action[]).map(a => (
            <button
              key={a}
              onClick={() => setAction(a)}
              title={a === 'DEPLOY' ? `Buy the full ${optType} strike list` : a === 'CANCEL' ? `Cancel pending ${optType} orders` : `Market${entryPrice ? '/LIMIT' : ''} ${a} of the ${optType}`}
              className={btn(action === a)}
            >
              <span className={a === 'SELL' ? 'text-[#ff4d5e]' : a === 'CANCEL' ? 'text-muted-foreground' : 'text-[#00c896]'}>{a}</span>
            </button>
          ))}
          <button onClick={() => setOptType(optType === 'CE' ? 'PE' : 'CE')} title="Option side" className={`${btn(optType === 'CE')} ${optType === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>
            {optType}
          </button>
        </div>

        {/* strikes: ATM ±5 buttons or picked set */}
        <div className="flex items-center gap-1">
          <button onClick={() => setPickStrikes(false)} className={btn(!pickStrikes)}>ATM</button>
          <button
            onClick={() => setPickStrikes(true)}
            className={btn(pickStrikes)}
            title="Pick specific strikes from the workspace strike list (or a set of strikes)"
          >Strikes</button>
          {!pickStrikes ? (
            <div className="flex items-center gap-0.5">
              {[-5, -4, -3, -2, -1].map(o => (
                <button key={o} onClick={() => setOffset(o)} className={`h-4.5 w-5 text-[9px] tabular rounded ${offset === o ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:text-foreground'}`}>{o}</button>
              ))}
              <button onClick={() => setOffset(0)} className={`px-1 h-4.5 text-[9px] font-bold rounded ${offset === 0 ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:text-foreground'}`}>ATM</button>
              {[1, 2, 3, 4, 5].map(o => (
                <button key={o} onClick={() => setOffset(o)} className={`h-4.5 w-5 text-[9px] tabular rounded ${offset === o ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:text-foreground'}`}>+{o}</button>
              ))}
            </div>
          ) : (
            <span className="text-[8px] text-muted-foreground">{Object.keys(picked).length} picked from {optType} rows</span>
          )}
        </div>

        {pickStrikes && (
          <div className="rounded bg-secondary/30 p-1 space-y-0.5 max-h-28 overflow-y-auto">
            {wsRows.length === 0 && <div className="text-[9px] text-muted-foreground px-1">No {optType} strikes in the Strikes panel — add some first.</div>}
            {wsRows.map(r => (
              <label key={r.id} className="flex items-center gap-1.5 px-1 py-0.5 text-[10px] cursor-pointer hover:bg-secondary/50 rounded">
                <input
                  type="checkbox"
                  checked={!!picked[r.id]}
                  onChange={e => togglePicked(r.id, r.strike, e.target.checked)}
                  className="accent-[#3b82f6] h-3 w-3"
                />
                <span className="tabular font-semibold w-14">{r.strike}</span>
                <span className={`text-[8px] font-bold ${r.type === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>{r.type}</span>
                <div className="flex-1" />
                <input
                  value={picked[r.id] ?? allocPct}
                  onChange={e => setPicked(p => ({ ...p, [r.id]: Math.max(1, Math.min(100, Number(e.target.value.replace(/[^0-9]/g, '')) || 1)) }))}
                  className="h-4 w-10 rounded bg-secondary/60 text-center text-[9px] tabular outline-none"
                  title="Alloc % for this strike"
                />
                <span className="text-[8px] text-muted-foreground">%</span>
              </label>
            ))}
          </div>
        )}

        {/* alloc + optional order legs */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-muted-foreground">alloc</span>
          <input
            type="range" min={5} max={100} step={5} value={allocPct}
            onChange={e => setAllocPct(Number(e.target.value))}
            className="h-1 w-12 accent-[#3b82f6]"
          />
          <span className="tabular text-[9px] w-7 text-right">{allocPct}%</span>
          <span className="text-[8px] text-muted-foreground uppercase tracking-wide shrink-0">legs</span>
          <Input value={entryPrice} onChange={e => setEntryPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="entry ₹" className="h-6 w-[56px] text-[9px] tabular bg-secondary/60" title="Entry — LIMIT at this price (blank = market)" />
          <Input value={stopLoss} onChange={e => setStopLoss(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="sl ₹" className="h-6 w-[50px] text-[9px] tabular bg-secondary/60" title="Stop-loss — reduce-only SL-M trigger" />
          <Input value={target} onChange={e => setTarget(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="tgt ₹" className="h-6 w-[50px] text-[9px] tabular bg-secondary/60" title="Target — reduce-only LIMIT" />
        </div>

        <div className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-[9px] text-muted-foreground cursor-pointer" title="Repeat every trading day (else fires once)">
            <input type="checkbox" checked={repeatDaily} onChange={e => setRepeatDaily(e.target.checked)} className="accent-[#3b82f6] h-3 w-3" />
            daily
          </label>
          <Button size="sm" className="h-6 px-2 text-[10px] ml-auto" onClick={create} disabled={busy}>Arm</Button>
        </div>

        <div className="text-[8px] text-muted-foreground leading-snug">
          {[
            useTime ? `at ${time} IST${repeatDaily ? ' daily' : ' (once)'}` : null,
            useRange ? `index in ${lo || '—'}–${hi || '—'}` : null,
            usePremium ? `premium ${pmode === 'LTE' ? `≤ ${pHi || '—'}` : pmode === 'GTE' ? `≥ ${pLo || '—'}` : `${pLo || '—'}–${pHi || '—'}`}` : null,
          ].filter(Boolean).join(' + ')}
          {' → '}{action} {optType}{pickStrikes ? ` ×${Object.keys(picked).length} picked` : offset ? ` side-ATM ${offset > 0 ? '+' : ''}${offset}` : ' side-ATM'} · {allocPct}%
          {entryPrice && ` · LIMIT ${entryPrice}`}{stopLoss && ` · SL ${stopLoss}`}{target && ` · TGT ${target}`}. Fires server-side.
        </div>
      </div>

      {/* rules list */}
      <div className="flex-1 overflow-y-auto">
        {rules.length === 0 && (
          <div className="p-3 text-center text-[10px] text-muted-foreground leading-relaxed">
            No rules yet. Arm a time / range / premium<br />rule above — compound conditions supported.
          </div>
        )}
        {rules.map(r => (
          <div key={r.id} className="px-2 py-1.5 border-b border-border/50 flex items-start gap-1.5">
            {r.kind === 'INDEX' ? <Gauge className="h-3 w-3 mt-0.5 text-[#4dd0e1] shrink-0" />
              : r.kind === 'INDEX_RANGE' ? <Webhook className="h-3 w-3 mt-0.5 text-[#a78bfa] shrink-0" />
              : r.kind === 'COMPOUND' ? <Layers className="h-3 w-3 mt-0.5 text-[#e0a63f] shrink-0" />
              : <Clock3 className="h-3 w-3 mt-0.5 text-[#f5a623] shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-[10px] font-semibold">{r.name}</span>
              </div>
              <div className="text-[8px] text-muted-foreground">
                {r.underlying} · {r.kind.toLowerCase()} · {r.action}{' '}
                <b className={r.optType === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}>{r.optType}</b>{' '}
                {r.strikes && r.strikes.length > 0
                  ? `×${r.strikes.length} strikes`
                  : r.offset === 0 ? 'ATM' : r.offset > 0 ? `+${r.offset}` : r.offset}
                {' · '}{r.allocPct}%{r.repeatDaily ? ' · daily' : ' · once'}
                {(r.entryPrice || r.stopLoss || r.target) && (
                  <span className="ml-1 text-[#e0a63f]">
                    [{r.entryPrice ? `e${r.entryPrice}` : ''}{r.stopLoss ? ` sl${r.stopLoss}` : ''}{r.target ? ` t${r.target}` : ''}]
                  </span>
                )}
              </div>
              {r.lastFiredAt && (
                <div className="text-[8px]">
                  <span className={r.lastStatus === 'FIRED' ? 'term-up' : 'term-down'}>
                    {r.lastStatus} {fmtTime(r.lastFiredAt)}
                  </span>
                  {r.lastMessage && <span className="text-muted-foreground"> — {r.lastMessage}</span>}
                </div>
              )}
            </div>
            <Switch checked={r.enabled} onCheckedChange={v => toggle(r.id, v)} />
            <button onClick={() => remove(r.id)} className="p-0.5 rounded text-muted-foreground hover:text-[#ff4d5e]" title="Delete rule">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
