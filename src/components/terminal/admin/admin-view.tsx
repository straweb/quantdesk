'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { RefreshCw, Trash2, Download, Radio, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, fmtInr, fmtDateTime } from '../lib/client-api'
import { BROKER_META, CAPITAL_MODES } from '@/lib/types'
import type { BrokerType, CapitalMode } from '@/lib/types'

export function AdminView() {
  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 max-w-6xl mx-auto">
      <AccountsManager />
      <div className="grid lg:grid-cols-2 gap-4">
        <CopyTradeManager />
        <MasterContracts />
      </div>
      <AuditTrail />
    </div>
  )
}

// ---------------- Broker accounts ----------------
function AccountsManager() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts(), refetchInterval: 5000 })
  const [dlgOpen, setDlgOpen] = useState(false)
  const [form, setForm] = useState<{ label: string; brokerType: BrokerType; clientId: string; initialCapital: string; mode: CapitalMode; apiKey: string; secret: string }>({
    label: '', brokerType: 'SIMFEED', clientId: '', initialCapital: '500000', mode: 'INITIAL_PLUS_PNL', apiKey: '', secret: '',
  })

  const accounts = data?.accounts ?? []

  const create = async () => {
    try {
      const credentials: Record<string, string> = {}
      if (form.apiKey) credentials[credentialKeyFor(form.brokerType)] = form.apiKey
      if (form.secret) credentials[secretKeyFor(form.brokerType)] = form.secret
      await api.createAccount({
        label: form.label,
        brokerType: form.brokerType,
        clientId: form.clientId || null,
        initialCapital: Number(form.initialCapital),
        mode: form.mode,
        credentials: Object.keys(credentials).length ? credentials : undefined,
      })
      toast.success(`Account "${form.label}" added`)
      setDlgOpen(false)
      setForm({ ...form, label: '', clientId: '', apiKey: '', secret: '' })
      qc.invalidateQueries({ queryKey: ['accounts'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    }
  }

  const patch = async (id: string, body: Record<string, unknown>) => {
    await api.patchAccount(id, body).catch(e => toast.error(e.message))
    qc.invalidateQueries({ queryKey: ['accounts'] })
  }

  const remove = async (id: string, label: string) => {
    await api.deleteAccount(id).catch(e => toast.error(e.message))
    toast.success(`Removed ${label}`)
    qc.invalidateQueries({ queryKey: ['accounts'] })
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h3 className="text-sm font-semibold">Broker Accounts</h3>
          <p className="text-[11px] text-muted-foreground">Add N accounts of any broker · mark ONE as live data source · enable the set that receives orders</p>
        </div>
        <Dialog open={dlgOpen} onOpenChange={setDlgOpen}>
          <DialogTrigger asChild><Button size="sm" className="text-xs">+ Add Account</Button></DialogTrigger>
          <DialogContent className="bg-popover">
            <DialogHeader><DialogTitle>Add Broker Account</DialogTitle></DialogHeader>
            <div className="space-y-3 text-xs">
              <Field label="Label">
                <Input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="e.g. Dhan Prop Desk 2" className="h-8" />
              </Field>
              <Field label="Broker">
                <Select value={form.brokerType} onValueChange={v => setForm({ ...form, brokerType: v as BrokerType })}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(BROKER_META) as BrokerType[]).map(b => (
                      <SelectItem key={b} value={b}>{BROKER_META[b].name} — {BROKER_META[b].doc}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Client ID">
                <Input value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} className="h-8" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Initial Capital ₹">
                  <Input type="number" value={form.initialCapital} onChange={e => setForm({ ...form, initialCapital: e.target.value })} className="h-8 tabular" />
                </Field>
                <Field label="Capital Sizing Mode">
                  <Select value={form.mode} onValueChange={v => setForm({ ...form, mode: v as CapitalMode })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(CAPITAL_MODES) as CapitalMode[]).map(m => <SelectItem key={m} value={m}>{CAPITAL_MODES[m].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label={credentialLabelFor(form.brokerType)} hint="Encrypted at rest (AES-256-GCM). Leave blank for sandbox mode.">
                <Input value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} className="h-8" />
              </Field>
              <Field label={secretLabelFor(form.brokerType)}>
                <Input type="password" value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} className="h-8" />
              </Field>
              <Button className="h-8 text-xs" onClick={create} disabled={!form.label}>Add Account</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <div className="divide-y divide-border">
        {accounts.map(a => (
          <div key={a.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-[210px]">
              <div className="text-xs font-medium flex items-center gap-1.5">
                {a.label}
                {a.isLiveDataSource && <span className="text-[8px] px-1 py-0.5 rounded bg-[#4dd0e1]/15 text-[#4dd0e1] flex items-center gap-0.5"><Radio className="h-2.5 w-2.5" />DATA</span>}
                {a.isCopyMaster && <span className="text-[8px] px-1 py-0.5 rounded bg-[#f5a623]/15 text-[#f5a623]">MASTER</span>}
              </div>
              <div className="text-[10px] text-muted-foreground">{BROKER_META[a.brokerType as BrokerType]?.name} · {a.clientId ?? '—'}</div>
            </div>
            <CapCell label="Usable" value={a.usableCapital} />
            <CapCell label="Initial" value={a.initialCapital} />
            <CapCell label="PnL" value={a.realizedPnl} pnl />
            <CapCell label="Charges" value={a.chargesPaid} muted />
            <CapCell label="Deployed" value={a.deployed} muted />
            <div className="flex items-center gap-3">
              <Flag
                on={a.isLiveDataSource}
                label="Data"
                onChange={v => patch(a.id, { isLiveDataSource: v })}
              />
              <Flag
                on={a.isOrderEnabled}
                label="Orders"
                onChange={v => patch(a.id, { isOrderEnabled: v })}
              />
              <Flag
                on={a.isCopyMaster}
                label="Master"
                onChange={v => patch(a.id, { isCopyMaster: v })}
              />
            </div>
            <div className="flex items-center gap-1 ml-auto">
              <ModeSelect id={a.id} current={a.modeLabel} />
              <Button variant="ghost" size="sm" className="h-7 px-1.5" title="Delete"
                onClick={() => remove(a.id, a.label)}>
                <Trash2 className="h-3.5 w-3.5 text-[#ff4d5e]" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function credentialKeyFor(b: BrokerType) {
  return b === 'DHAN' ? 'accessToken' : b === 'SHOONYA' ? 'sessionId' : b === 'ICICI_BREEZE' ? 'sessionToken' : 'apiKey'
}
function secretKeyFor(b: BrokerType) {
  return b === 'DHAN' ? 'clientId' : b === 'SHOONYA' ? 'userId' : b === 'ICICI_BREEZE' ? 'apiKey' : 'secret'
}
function credentialLabelFor(b: BrokerType) {
  return b === 'DHAN' ? 'Access Token' : b === 'SHOONYA' ? 'Session Token (jKey)' : b === 'ICICI_BREEZE' ? 'Session Token' : 'API Key'
}
function secretLabelFor(b: BrokerType) {
  return b === 'DHAN' ? 'Dhan Client ID' : b === 'SHOONYA' ? 'User ID' : b === 'ICICI_BREEZE' ? 'API Key' : 'Secret'
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      {children}
      {hint && <div className="text-[9px] text-muted-foreground/70">{hint}</div>}
    </div>
  )
}

function CapCell({ label, value, pnl, muted }: { label: string; value: number; pnl?: boolean; muted?: boolean }) {
  return (
    <div className="min-w-[86px]">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className={`text-[11px] tabular ${pnl ? (value >= 0 ? 'term-up' : 'term-down') : muted ? 'text-muted-foreground' : ''}`}>{fmtInr(value)}</div>
    </div>
  )
}

function Flag({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer select-none">
      <Switch checked={on} onCheckedChange={onChange} className="scale-[0.8]" />
      <span className={`text-[10px] ${on ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
    </label>
  )
}

function ModeSelect({ id, current }: { id: string; current: string | null }) {
  const qc = useQueryClient()
  return (
    <Select value={current ?? undefined} onValueChange={v => api.patchAccount(id, { mode: v }).then(() => qc.invalidateQueries({ queryKey: ['accounts'] }))}>
      <SelectTrigger className="h-7 w-[150px] text-[10px]"><SelectValue placeholder="sizing mode" /></SelectTrigger>
      <SelectContent>
        {(Object.keys(CAPITAL_MODES) as CapitalMode[]).map(m => (
          <SelectItem key={m} value={m} className="text-[11px]">
            <span title={CAPITAL_MODES[m].detail}>{CAPITAL_MODES[m].label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------- Copy trading ----------------
function CopyTradeManager() {
  const qc = useQueryClient()
  const { data: ct } = useQuery({ queryKey: ['copytrade-admin'], queryFn: () => api.copyTrade(), refetchInterval: 5000 })
  const { data: acc } = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts() })
  const cfg = ct?.config
  const accounts = acc?.accounts ?? []

  const patch = async (body: Record<string, unknown>) => {
    await api.patchCopyTrade(body).catch(e => toast.error(e.message))
    qc.invalidateQueries({ queryKey: ['copytrade-admin'] })
    qc.invalidateQueries({ queryKey: ['copytrade-quick'] })
  }

  if (!cfg) return null
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Copy Trading Engine</h3>
          <p className="text-[11px] text-muted-foreground">Orders placed from the terminal fan out to every order-enabled account, sized by each account&apos;s capital rules.</p>
        </div>
        <Switch checked={cfg.enabled} onCheckedChange={v => patch({ enabled: v })} />
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <Field label="Mirror source (master account)">
          <Select value={cfg.masterAccountId ?? ''} onValueChange={v => patch({ masterAccountId: v })}>
            <SelectTrigger className="h-8"><SelectValue placeholder="Any manual order" /></SelectTrigger>
            <SelectContent>
              {accounts.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label={`Capital share per signal — ${cfg.capitalSharePct}%`}>
          <input
            type="range" min={5} max={100} step={5} value={cfg.capitalSharePct}
            onChange={e => patch({ capitalSharePct: Number(e.target.value) })}
            className="w-full accent-[#f5a623]"
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className={`text-xs h-8 ${cfg.killSwitch ? 'bg-[#ff4d5e] hover:bg-[#f03d4e] text-black' : ''}`}
          onClick={() => patch({ killSwitch: !cfg.killSwitch })}
        >
          {cfg.killSwitch ? <><ShieldAlert className="h-3.5 w-3.5 mr-1" /> Kill Switch ACTIVE</> : <><ShieldCheck className="h-3.5 w-3.5 mr-1" /> Arm Kill Switch</>}
        </Button>
        <span className="text-[10px] text-muted-foreground">Kill switch blocks all order routing instantly.</span>
      </div>
    </div>
  )
}

// ---------------- Master contracts ----------------
function MasterContracts() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['sync-info'], queryFn: () => api.syncInfo(), refetchInterval: 15000 })
  const [busy, setBusy] = useState(false)

  const sync = async () => {
    setBusy(true)
    try {
      const r = await api.syncSymbols()
      toast.success(`Master contracts synced — ${r.symbolCount} symbols, ${r.mappedCount} broker mappings (${r.version})`)
      qc.invalidateQueries({ queryKey: ['sync-info'] })
      qc.invalidateQueries({ queryKey: ['symbols'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed')
    } finally { setBusy(false) }
  }

  const stale = data?.lastSync ? Date.now() - new Date(data.lastSync).getTime() > 20 * 3600_000 : true
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Master Contracts (Symbols)</h3>
          <p className="text-[11px] text-muted-foreground">Daily download & mapping to every broker&apos;s own symbol/token for copy trading.</p>
        </div>
        <Button size="sm" className="text-xs h-8" disabled={busy} onClick={sync}>
          {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Sync Now
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Symbols" value={String(data?.counts.symbols ?? '—')} />
        <Stat label="Broker Mappings" value={String(data?.counts.mappings ?? '—')} />
        <Stat label="Last Sync" value={data?.lastSync ? fmtDateTime(data.lastSync) : 'never'} warn={stale} />
      </div>
      <div className="text-[10px] text-muted-foreground">
        Auto-sync runs on server boot; a sync older than 20h is flagged stale so the daily job can be triggered here or via cron.
      </div>
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded bg-secondary/50 px-2 py-1.5">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className={`text-[11px] tabular ${warn ? 'text-[#f5a623]' : ''}`}>{value}</div>
    </div>
  )
}

// ---------------- Audit trail ----------------
function AuditTrail() {
  const { data } = useQuery({ queryKey: ['audit'], queryFn: () => api.audit(), refetchInterval: 4000 })
  const rows = data?.audits ?? []
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">Order Audit Trail</h3>
        <p className="text-[11px] text-muted-foreground">Every master order and its per-account fan-out legs.</p>
      </div>
      <div className="divide-y divide-border max-h-64 overflow-y-auto">
        {rows.map(r => {
          const legs = safeLegs(r.legsJson)
          return (
            <div key={r.id} className="px-4 py-2 text-[11px]">
              <button className="w-full flex items-center gap-3 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <span className="text-muted-foreground tabular">{fmtDateTime(r.ts)}</span>
                <span className="px-1 rounded bg-secondary text-[9px]">{r.source}</span>
                <span className="font-medium">{r.masterSymbol}</span>
                <span className={r.side === 'BUY' ? 'term-up' : r.side === 'SELL' ? 'term-down' : ''}>{r.side}</span>
                <span className="tabular">{r.qty || '—'}</span>
                <span className={`px-1 rounded text-[9px] ${r.status === 'SUCCESS' ? 'bg-[#00c896]/15 text-[#00c896]' : r.status === 'PARTIAL' ? 'bg-[#f5a623]/15 text-[#f5a623]' : 'bg-[#ff4d5e]/15 text-[#ff4d5e]'}`}>{r.status}</span>
                <span className="text-muted-foreground ml-auto">{legs.length} legs {open === r.id ? '▾' : '▸'}</span>
              </button>
              {open === r.id && (
                <div className="mt-1.5 ml-4 space-y-0.5 text-[10px]">
                  {legs.map((l, i) => (
                    <div key={i} className="flex gap-2">
                      <span className={l.status === 'FILLED' ? 'term-up' : l.status === 'SKIPPED' ? 'text-[#f5a623]' : 'term-down'}>{l.status}</span>
                      <span className="text-muted-foreground">{l.accountLabel}</span>
                      <span className="tabular">{l.qty ? `${l.qty} @ ${l.price ?? '-'}` : l.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {rows.length === 0 && <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">No orders routed yet</div>}
      </div>
    </div>
  )
}

function safeLegs(json: string | null): { accountLabel: string; status: string; qty: number; price?: number; message?: string }[] {
  try { return JSON.parse(json || '[]') } catch { return [] }
}
