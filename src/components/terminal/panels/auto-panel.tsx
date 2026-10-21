'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bot, Clock3, Gauge, Trash2, Webhook } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, fmtTime } from '../lib/client-api'
import type { WorkspaceCfg } from '../lib/store'

// ============================================================
// Auto bot (right dock "Auto" tab) — rule builder v2.
//  · Trigger: TIME (HH:MM:SS, seconds precision — server ticks 250ms)
//    | INDEX (cross above/below a level) | RANGE (spot enters [lo, hi])
//  · Action: BUY / SELL a CE/PE, DEPLOY a whole side's strike list,
//    or CANCEL pending orders of that side
//  · Strikes: side-ATM + offset, or a user-picked set from the
//    workspace's strike rows (each with its own alloc %)
//  · Optional price legs (any subset): entry (LIMIT), stop-loss
//    (reduce-only SL-M), target (reduce-only LIMIT)
// Rules run server-side — they fire even when the terminal is closed.
// ============================================================

type Kind = 'TIME' | 'INDEX' | 'INDEX_RANGE'
type Action = 'BUY' | 'SELL' | 'DEPLOY' | 'CANCEL'

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

  // create-form state
  const [kind, setKind] = useState<Kind>('TIME')
  const [underlying, setUnderlying] = useState(defaultUnderlying)
  const [level, setLevel] = useState('')
  const [cross, setCross] = useState<'ABOVE' | 'BELOW'>('ABOVE')
  const [lo, setLo] = useState('')
  const [hi, setHi] = useState('')
  const [time, setTime] = useState('09:30:00')
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
    if (kind === 'INDEX' && !level) { toast.error('Enter the index level'); return }
    if (kind === 'INDEX_RANGE' && (!lo || !hi)) { toast.error('Enter the range low and high'); return }
    if (kind === 'TIME' && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(time)) { toast.error('Time must be HH:MM or HH:MM:SS'); return }
    if (pickStrikes && Object.keys(picked).length === 0) { toast.error('Pick at least one strike (or switch to ATM mode)'); return }
    const strikes = pickStrikes ? pickedList() : undefined
    const name = `${action} ${optType}${strikes?.length ? ` ×${strikes.length}` : offset ? (offset > 0 ? ` +${offset}` : ` ${offset}`) : ' ATM'} ${
      kind === 'TIME' ? `@ ${time}` : kind === 'INDEX' ? `@ ${cross.toLowerCase()} ${level}` : `in ${lo}-${hi}`
    }${entryPrice ? ` · e${entryPrice}` : ''}${stopLoss ? ` · sl${stopLoss}` : ''}${target ? ` · t${target}` : ''}`
    setBusy(true)
    try {
      await api.createAutoRule({
        name,
        underlying: effUnderlying,
        expiry: ws.strikes?.expiry ?? null,
        kind,
        level: kind === 'INDEX' ? Number(level) : undefined,
        cross: kind === 'INDEX' ? cross : undefined,
        lo: kind === 'INDEX_RANGE' ? Number(lo) : undefined,
        hi: kind === 'INDEX_RANGE' ? Number(hi) : undefined,
        time: kind === 'TIME' ? time : undefined,
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
      setLevel(''); setLo(''); setHi('')
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
          {(['TIME', 'INDEX', 'INDEX_RANGE'] as Kind[]).map(k => (
            <button key={k} onClick={() => setKind(k)} className={btn(kind === k)}>
              {k === 'TIME' ? 'Time' : k === 'INDEX' ? 'Index' : 'Range'}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          <select value={effUnderlying} onChange={e => setUnderlying(e.target.value)} className={`${sel} flex-1 min-w-0`}>
            {unds.map(u => <option key={u.underlying} value={u.underlying}>{u.underlying}</option>)}
          </select>
          {kind === 'INDEX' && (
            <>
              <button onClick={() => setCross(cross === 'ABOVE' ? 'BELOW' : 'ABOVE')} className={btn(cross === 'ABOVE')} title="Cross direction">
                {cross === 'ABOVE' ? '≥' : '≤'}
              </button>
              <Input
                value={level}
                onChange={e => setLevel(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="index level"
                className="h-6 w-[68px] text-[10px] tabular bg-secondary/60"
              />
            </>
          )}
          {kind === 'INDEX_RANGE' && (
            <>
              <Input value={lo} onChange={e => setLo(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="lo" className="h-6 w-[52px] text-[10px] tabular bg-secondary/60" />
              <span className="text-muted-foreground text-[9px] self-center">–</span>
              <Input value={hi} onChange={e => setHi(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="hi" className="h-6 w-[52px] text-[10px] tabular bg-secondary/60" />
            </>
          )}
          {kind === 'TIME' && (
            <Input
              value={time}
              onChange={e => setTime(e.target.value.replace(/[^0-9:]/g, ''))}
              placeholder="HH:MM:SS"
              className="h-6 w-[84px] text-[10px] tabular bg-secondary/60"
              title="Fires at this IST time (seconds precision)"
            />
          )}
        </div>

        {/* action + option type */}
        <div className="flex items-center gap-1">
          {(['BUY', 'SELL', 'DEPLOY', 'CANCEL'] as Action[]).map(a => (
            <button
              key={a}
              onClick={() => setAction(a)}
              title={a === 'DEPLOY' ? `Buy the full ${optType} strike list` : a === 'CANCEL' ? `Cancel pending ${optType} orders` : `Market${entryPrice ? '/LIMIT' : ''} ${a} of the ${optType}`}
              className={`${btn(action === a)} ${a === 'BUY' || a === 'DEPLOY' ? (action === a ? '' : '') : ''}`}
            >
              <span className={a === 'SELL' ? 'text-[#ff4d5e]' : a === 'CANCEL' ? 'text-muted-foreground' : 'text-[#00c896]'}>{a === 'DEPLOY' ? 'DEPLOY' : a === 'CANCEL' ? 'CANCEL' : a}</span>
            </button>
          ))}
          <button onClick={() => setOptType(optType === 'CE' ? 'PE' : 'CE')} title="Option side" className={`${btn(optType === 'CE')} ${optType === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>
            {optType}
          </button>
        </div>

        {/* strikes: ATM+offset or picked set */}
        <div className="flex items-center gap-1">
          <button onClick={() => setPickStrikes(false)} className={btn(!pickStrikes)}>ATM</button>
          <button
            onClick={() => setPickStrikes(true)}
            className={btn(pickStrikes)}
            title="Pick specific strikes from the workspace strike list (or a set of strikes)"
          >Strikes</button>
          {!pickStrikes ? (
            <select value={offset} onChange={e => setOffset(Number(e.target.value))} className={sel} title="Offset from side ATM (steps)">
              {[-3, -2, -1, 0, 1, 2, 3].map(o => <option key={o} value={o}>{o === 0 ? 'ATM' : o > 0 ? `+${o}` : o}</option>)}
            </select>
          ) : (
            <span className="text-[8px] text-muted-foreground">{Object.keys(picked).length} picked from {optType} rows</span>
          )}
          <div className="flex-1" />
          <span className="text-[9px] text-muted-foreground">alloc</span>
          <input
            type="range" min={5} max={100} step={5} value={allocPct}
            onChange={e => setAllocPct(Number(e.target.value))}
            className="h-1 w-12 accent-[#3b82f6]"
          />
          <span className="tabular text-[9px] w-7 text-right">{allocPct}%</span>
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

        {/* optional price legs — any subset */}
        <div className="flex items-center gap-1">
          <span className="text-[8px] text-muted-foreground uppercase tracking-wide shrink-0">optional</span>
          <Input value={entryPrice} onChange={e => setEntryPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="entry ₹" className="h-6 w-[58px] text-[9px] tabular bg-secondary/60" title="Entry — LIMIT at this price (blank = market)" />
          <Input value={stopLoss} onChange={e => setStopLoss(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="sl ₹" className="h-6 w-[52px] text-[9px] tabular bg-secondary/60" title="Stop-loss — reduce-only SL-M trigger" />
          <Input value={target} onChange={e => setTarget(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="tgt ₹" className="h-6 w-[52px] text-[9px] tabular bg-secondary/60" title="Target — reduce-only LIMIT" />
          <label className="flex items-center gap-1 text-[9px] text-muted-foreground cursor-pointer" title="Repeat every trading day (else fires once)">
            <input type="checkbox" checked={repeatDaily} onChange={e => setRepeatDaily(e.target.checked)} className="accent-[#3b82f6] h-3 w-3" />
            daily
          </label>
          <Button size="sm" className="h-6 px-2 text-[10px] ml-auto" onClick={create} disabled={busy}>Arm</Button>
        </div>

        <div className="text-[8px] text-muted-foreground leading-snug">
          {kind === 'TIME'
            ? `At ${time} IST${repeatDaily ? ' daily' : ' (once)'}`
            : kind === 'INDEX'
              ? `When ${effUnderlying || 'spot'} crosses ${cross === 'ABOVE' ? 'above' : 'below'} ${level || '—'}`
              : `When ${effUnderlying || 'spot'} enters ${lo || '—'}–${hi || '—'}`}
          {' → '}{action} {optType}{pickStrikes ? ` ×${Object.keys(picked).length} picked` : offset ? ` side-ATM ${offset > 0 ? '+' : ''}${offset}` : ' side-ATM'} · {allocPct}%
          {entryPrice && ` · LIMIT ${entryPrice}`}{stopLoss && ` · SL ${stopLoss}`}{target && ` · TGT ${target}`}. Fires server-side.
        </div>
      </div>

      {/* rules list */}
      <div className="flex-1 overflow-y-auto">
        {rules.length === 0 && (
          <div className="p-3 text-center text-[10px] text-muted-foreground leading-relaxed">
            No rules yet. Arm a time / index / range<br />rule above — seconds precision supported.
          </div>
        )}
        {rules.map(r => (
          <div key={r.id} className="px-2 py-1.5 border-b border-border/50 flex items-start gap-1.5">
            {r.kind === 'INDEX' ? <Gauge className="h-3 w-3 mt-0.5 text-[#4dd0e1] shrink-0" />
              : r.kind === 'INDEX_RANGE' ? <Webhook className="h-3 w-3 mt-0.5 text-[#a78bfa] shrink-0" />
              : <Clock3 className="h-3 w-3 mt-0.5 text-[#f5a623] shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-[10px] font-semibold">{r.name}</span>
              </div>
              <div className="text-[8px] text-muted-foreground">
                {r.underlying} · {r.action}{' '}
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
