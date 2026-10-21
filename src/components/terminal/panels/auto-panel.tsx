'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bot, Clock3, Gauge, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, fmtTime } from '../lib/client-api'
import type { WorkspaceCfg } from '../lib/store'

// ============================================================
// Auto rules panel (right dock "Auto" tab) — index-based and
// time-based CE/PE buy/sell automation.
//  · INDEX rule: when spot crosses above/below a level ->
//    BUY/SELL CE/PE at side-ATM + offset
//  · TIME rule: at HH:MM IST -> same action (once per day)
// Rules run server-side (1s scheduler) — they fire even when
// the terminal tab is closed.
// ============================================================

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
  const [kind, setKind] = useState<'INDEX' | 'TIME'>('INDEX')
  const [underlying, setUnderlying] = useState(defaultUnderlying)
  const [level, setLevel] = useState('')
  const [cross, setCross] = useState<'ABOVE' | 'BELOW'>('ABOVE')
  const [time, setTime] = useState('09:30')
  const [action, setAction] = useState<'BUY' | 'SELL'>('BUY')
  const [optType, setOptType] = useState<'CE' | 'PE'>('CE')
  const [offset, setOffset] = useState(0)
  const [allocPct, setAllocPct] = useState(100)
  const [busy, setBusy] = useState(false)

  const effUnderlying = underlying || defaultUnderlying

  const create = async () => {
    if (!effUnderlying) { toast.error('Pick an F&O underlying'); return }
    if (kind === 'INDEX' && !level) { toast.error('Enter the index level'); return }
    setBusy(true)
    try {
      await api.createAutoRule({
        name: `${action} ${optType}${offset ? (offset > 0 ? ` +${offset}` : ` ${offset}`) : ' ATM'} ${kind === 'INDEX' ? `@ ${cross.toLowerCase()} ${level}` : `@ ${time}`}`,
        underlying: effUnderlying,
        expiry: ws.strikes?.expiry ?? null,
        kind,
        level: kind === 'INDEX' ? Number(level) : undefined,
        cross: kind === 'INDEX' ? cross : undefined,
        time: kind === 'TIME' ? time : undefined,
        action, optType, offset, allocPct,
        enabled: true,
        repeatDaily: true,
      })
      await qc.invalidateQueries({ queryKey: ['autorules'] })
      toast.success('Auto rule armed')
      setLevel('')
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
          <span className="text-[10px] font-bold uppercase tracking-wide">Auto rules</span>
          <div className="flex-1" />
          <button onClick={() => setKind('INDEX')} className={btn(kind === 'INDEX')}>Index</button>
          <button onClick={() => setKind('TIME')} className={btn(kind === 'TIME')}>Time</button>
        </div>

        <div className="flex gap-1">
          <select value={effUnderlying} onChange={e => setUnderlying(e.target.value)} className={`${sel} flex-1 min-w-0`}>
            {unds.map(u => <option key={u.underlying} value={u.underlying}>{u.underlying}</option>)}
          </select>
          {kind === 'INDEX' ? (
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
          ) : (
            <Input
              type="time"
              value={time}
              onChange={e => setTime(e.target.value)}
              className="h-6 w-[92px] text-[10px] tabular bg-secondary/60"
            />
          )}
        </div>

        <div className="flex items-center gap-1">
          <button onClick={() => setAction(action === 'BUY' ? 'SELL' : 'BUY')} title="Order side" className={btn(action === 'BUY')}>
            <span className={action === 'BUY' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}>{action}</span>
          </button>
          <button onClick={() => setOptType(optType === 'CE' ? 'PE' : 'CE')} title="Option type" className={`${btn(optType === 'CE')} ${optType === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>
            {optType}
          </button>
          <select value={offset} onChange={e => setOffset(Number(e.target.value))} className={sel} title="Offset from side ATM (steps)">
            {[-3, -2, -1, 0, 1, 2, 3].map(o => <option key={o} value={o}>{o === 0 ? 'ATM' : o > 0 ? `+${o}` : o}</option>)}
          </select>
          <span className="text-[9px] text-muted-foreground">alloc</span>
          <input
            type="range" min={5} max={100} step={5} value={allocPct}
            onChange={e => setAllocPct(Number(e.target.value))}
            className="h-1 w-12 accent-[#3b82f6]"
          />
          <span className="tabular text-[9px] w-7 text-right">{allocPct}%</span>
          <Button size="sm" className="h-6 px-2 text-[10px]" onClick={create} disabled={busy}>Arm</Button>
        </div>
        <div className="text-[8px] text-muted-foreground leading-snug">
          {kind === 'INDEX'
            ? `When ${effUnderlying || 'spot'} crosses ${cross === 'ABOVE' ? 'above' : 'below'} ${level || '—'}, ${action} ${optType} at side-ATM${offset ? ` ${offset > 0 ? '+' : ''}${offset}` : ''} · ${allocPct}% of usable capital per enabled account.`
            : `At ${time} IST (once per day), ${action} ${optType} at side-ATM${offset ? ` ${offset > 0 ? '+' : ''}${offset}` : ''} · ${allocPct}% of usable capital per enabled account.`}
          Fires server-side even with the terminal closed.
        </div>
      </div>

      {/* rules list */}
      <div className="flex-1 overflow-y-auto">
        {rules.length === 0 && (
          <div className="p-3 text-center text-[10px] text-muted-foreground leading-relaxed">
            No rules yet. Arm an index-crossing or<br />time-based entry above.
          </div>
        )}
        {rules.map(r => (
          <div key={r.id} className="px-2 py-1.5 border-b border-border/50 flex items-start gap-1.5">
            {r.kind === 'INDEX' ? <Gauge className="h-3 w-3 mt-0.5 text-[#4dd0e1] shrink-0" /> : <Clock3 className="h-3 w-3 mt-0.5 text-[#f5a623] shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-[10px] font-semibold">{r.name}</span>
              </div>
              <div className="text-[8px] text-muted-foreground">
                {r.underlying} · {r.action === 'BUY' ? <b className="text-[#00c896]">BUY</b> : <b className="text-[#ff4d5e]">SELL</b>}{' '}
                <b className={r.optType === 'CE' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}>{r.optType}</b>{' '}
                {r.offset === 0 ? 'ATM' : r.offset > 0 ? `+${r.offset}` : r.offset} · {r.allocPct}% · {r.repeatDaily ? 'daily' : 'once'}
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
