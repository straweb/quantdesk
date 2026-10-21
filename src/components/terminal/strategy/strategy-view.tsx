'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Play, Pause, Trash2, FileCode2, Plus, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, fmtDateTime } from '../lib/client-api'
import type { StrategyRow } from '../lib/client-api'

const STATUS_CLS: Record<string, string> = {
  IDLE: 'bg-secondary text-muted-foreground',
  WAITING_ENTRY: 'bg-[#4dd0e1]/15 text-[#4dd0e1]',
  IN_POSITION: 'bg-[#00c896]/15 text-[#00c896]',
  EXITED: 'bg-[#f5a623]/15 text-[#f5a623]',
  STOPPED: 'bg-secondary text-muted-foreground',
  ERROR: 'bg-[#ff4d5e]/15 text-[#ff4d5e]',
}

export function StrategyView() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['strategies'], queryFn: () => api.strategies(), refetchInterval: 2000 })
  const strategies = data?.strategies ?? []
  const [dlg, setDlg] = useState(false)
  const [pyId, setPyId] = useState<string | null>(null)

  const patch = async (id: string, body: Record<string, unknown>) => {
    await api.patchStrategy(id, body).catch(e => toast.error(e.message))
    qc.invalidateQueries({ queryKey: ['strategies'] })
  }
  const remove = async (id: string) => {
    await api.deleteStrategy(id).catch(e => toast.error(e.message))
    qc.invalidateQueries({ queryKey: ['strategies'] })
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Python Strategy Builder</h2>
          <p className="text-[11px] text-muted-foreground">
            Time-based entry/exit strategies · symbol auto-resolved from master contracts · LTP tracked from the feed ·
            entries fan out to all enabled accounts with capital house sizing · every strategy exports as runnable Python.
          </p>
        </div>
        <Dialog open={dlg} onOpenChange={setDlg}>
          <DialogTrigger asChild><Button size="sm" className="text-xs"><Plus className="h-3.5 w-3.5 mr-1" />New Strategy</Button></DialogTrigger>
          <DialogContent className="bg-popover max-w-lg">
            <DialogHeader><DialogTitle>Create Strategy</DialogTitle></DialogHeader>
            <StrategyForm onDone={() => { setDlg(false); qc.invalidateQueries({ queryKey: ['strategies'] }) }} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-2">
        {strategies.map(s => (
          <div key={s.id} className="rounded-lg border border-border bg-card">
            <div className="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <Switch checked={s.enabled} onCheckedChange={v => patch(s.id, { enabled: v })} />
              <div className="min-w-[150px]">
                <div className="text-xs font-medium">{s.name}</div>
                <div className="text-[9px] text-muted-foreground">{s.direction} · {s.symbol} · {s.productType} · {s.qtyMode === 'FIXED' ? `${s.fixedQty} lots` : `₹${s.capitalAmount ?? 'auto'} capital`}</div>
              </div>
              <div className="flex items-center gap-1 text-[10px] tabular">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span>in {s.entryTime} → out {s.exitTime}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                SL {s.stopLossPct ?? '—'}% · Tgt {s.targetPct ?? '—'}% · Trail {s.trailingSlPct ?? '—'}%
              </div>
              <span className={`px-1.5 py-0.5 rounded text-[9px] ${STATUS_CLS[s.status] ?? ''}`}>{s.status}</span>
              {s.entryPrice ? <span className="text-[10px] tabular">entry {s.entryPrice.toFixed(2)}</span> : null}
              <span className={`text-[10px] tabular ${s.realizedPnl >= 0 ? 'term-up' : 'term-down'}`}>{s.realizedPnl ? fmtDateTime(s.realizedPnl) && `${s.realizedPnl.toFixed(2)}` : '—'}</span>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => setPyId(s.id)} title="View Python">
                  <FileCode2 className="h-3.5 w-3.5" />
                </Button>
                {s.enabled
                  ? <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => patch(s.id, { enabled: false })} title="Pause"><Pause className="h-3.5 w-3.5 text-[#f5a623]" /></Button>
                  : <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => patch(s.id, { enabled: true })} title="Arm"><Play className="h-3.5 w-3.5 text-[#00c896]" /></Button>}
                <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => remove(s.id)} title="Delete"><Trash2 className="h-3.5 w-3.5 text-[#ff4d5e]" /></Button>
              </div>
            </div>
            {s.logs.length > 0 && (
              <div className="px-4 pb-2 font-mono text-[9px] text-muted-foreground space-y-0.5 max-h-20 overflow-y-auto">
                {s.logs.slice(0, 5).map(l => (
                  <div key={l.id} className={l.level === 'ERROR' ? 'term-down' : l.level === 'WARN' ? 'text-[#f5a623]' : ''}>
                    [{fmtDateTime(l.ts)}] {l.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {strategies.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-12 text-center text-xs text-muted-foreground">
            No strategies yet. Create a time-based strategy — it runs across all order-enabled accounts automatically.
          </div>
        )}
      </div>

      <Dialog open={!!pyId} onOpenChange={open => { if (!open) setPyId(null) }}>
        <PythonViewer id={pyId} onClose={() => setPyId(null)} />
      </Dialog>
    </div>
  )
}

function StrategyForm({ onDone }: { onDone: () => void }) {
  const { data: syms } = useQuery({ queryKey: ['symbols-form'], queryFn: () => api.symbols('', '') })
  const symbols = (syms?.symbols ?? []).filter(s => ['INDEX', 'EQ', 'FUT'].includes(s.instrumentType))
  const [f, setF] = useState({
    name: '', symbol: 'NIFTY', exchange: 'NSE', direction: 'LONG', productType: 'MIS',
    qtyMode: 'CAPITAL', fixedQty: '1', capitalAmount: '100000',
    entryTime: '09:20', entryWindowMin: '10', exitTime: '15:10',
    stopLossPct: '1', targetPct: '2', trailingSlPct: '',
    repeatDays: [1, 2, 3, 4, 5] as number[],
  })
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      await api.createStrategy({
        ...f,
        fixedQty: Number(f.fixedQty),
        capitalAmount: f.capitalAmount ? Number(f.capitalAmount) : null,
        entryWindowMin: Number(f.entryWindowMin),
        stopLossPct: f.stopLossPct || null,
        targetPct: f.targetPct || null,
        trailingSlPct: f.trailingSlPct || null,
        repeatDays: f.repeatDays.join(','),
        enabled: true,
      })
      toast.success(`Strategy "${f.name}" created and armed`)
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally { setBusy(false) }
  }

  const setSym = (sym: string) => {
    const s = symbols.find(x => x.symbol === sym)
    setF(prev => ({ ...prev, symbol: sym, exchange: s?.exchange ?? 'NSE' }))
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-3">
        <L label="Name"><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Opening Range Long" className="h-8" /></L>
        <L label="Symbol (master)">
          <Select value={f.symbol} onValueChange={setSym}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-64">
              {symbols.map(s => <SelectItem key={s.id} value={s.symbol} className="text-xs">{s.symbol} <span className="text-muted-foreground text-[9px]">{s.instrumentType}</span></SelectItem>)}
            </SelectContent>
          </Select>
        </L>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <L label="Direction">
          <Select value={f.direction} onValueChange={v => setF({ ...f, direction: v })}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="LONG" className="text-xs">LONG (BUY)</SelectItem><SelectItem value="SHORT" className="text-xs">SHORT (SELL)</SelectItem></SelectContent>
          </Select>
        </L>
        <L label="Product">
          <Select value={f.productType} onValueChange={v => setF({ ...f, productType: v })}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>{['MIS', 'CNC', 'NRML'].map(p => <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>)}</SelectContent>
          </Select>
        </L>
        <L label="Qty mode">
          <Select value={f.qtyMode} onValueChange={v => setF({ ...f, qtyMode: v })}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="CAPITAL" className="text-xs">By capital (per account)</SelectItem>
              <SelectItem value="FIXED" className="text-xs">Fixed lots</SelectItem>
            </SelectContent>
          </Select>
        </L>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {f.qtyMode === 'CAPITAL'
          ? <L label="Capital per run ₹" hint="Sized per account against its usable capital"><Input type="number" value={f.capitalAmount} onChange={e => setF({ ...f, capitalAmount: e.target.value })} className="h-8 tabular" /></L>
          : <L label="Fixed lots"><Input type="number" value={f.fixedQty} onChange={e => setF({ ...f, fixedQty: e.target.value })} className="h-8 tabular" /></L>}
        <L label="Repeat on">
          <div className="flex gap-1 pt-1">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <button
                key={i}
                onClick={() => setF({ ...f, repeatDays: f.repeatDays.includes(i) ? f.repeatDays.filter(x => x !== i) : [...f.repeatDays, i] })}
                className={`h-7 w-7 rounded text-[10px] ${f.repeatDays.includes(i) ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}
              >{d}</button>
            ))}
          </div>
        </L>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <L label="Entry time (IST)"><Input type="time" value={f.entryTime} onChange={e => setF({ ...f, entryTime: e.target.value })} className="h-8" /></L>
        <L label="Entry window (min)"><Input type="number" value={f.entryWindowMin} onChange={e => setF({ ...f, entryWindowMin: e.target.value })} className="h-8 tabular" /></L>
        <L label="Exit time (IST)"><Input type="time" value={f.exitTime} onChange={e => setF({ ...f, exitTime: e.target.value })} className="h-8" /></L>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <L label="Stop loss %"><Input type="number" value={f.stopLossPct} onChange={e => setF({ ...f, stopLossPct: e.target.value })} className="h-8 tabular" placeholder="—" /></L>
        <L label="Target %"><Input type="number" value={f.targetPct} onChange={e => setF({ ...f, targetPct: e.target.value })} className="h-8 tabular" placeholder="—" /></L>
        <L label="Trailing SL %"><Input type="number" value={f.trailingSlPct} onChange={e => setF({ ...f, trailingSlPct: e.target.value })} className="h-8 tabular" placeholder="—" /></L>
      </div>
      <div className="text-[9px] text-muted-foreground">
        Entry fires once inside [entry time, +window] on the selected days; exit at exit time or when SL/target/trailing triggers.
        Exits close each account&apos;s open position at its own size. Python export is written to /strategies.
      </div>
      <Button className="h-8 text-xs w-full" onClick={submit} disabled={busy || !f.name}>Create & Arm Strategy</Button>
    </div>
  )
}

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      {children}
      {hint && <div className="text-[9px] text-muted-foreground/70">{hint}</div>}
    </div>
  )
}

function PythonViewer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['strategy-python', id],
    queryFn: () => api.strategyPython(id!),
    enabled: !!id,
  })
  return (
    <DialogContent className="bg-popover max-w-3xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sm">
          <FileCode2 className="h-4 w-4" /> Python export {data?.filename ? `— ${data.filename}` : ''}
        </DialogTitle>
      </DialogHeader>
      <pre className="text-[10px] font-mono bg-[#0b0e11] rounded p-3 max-h-[60vh] overflow-auto leading-relaxed">
        {data?.code ?? 'loading…'}
      </pre>
      <div className="text-[9px] text-muted-foreground">
        Also saved to <code>/strategies/{data?.filename ?? ''}</code> on the server — run with python3.
      </div>
    </DialogContent>
  )
}
