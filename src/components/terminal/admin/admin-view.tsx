'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { KeyRound, RefreshCw, Trash2, Download, Radio, ShieldAlert, ShieldCheck, X } from 'lucide-react'
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
      <TickRecorder />
      <ReplayManager />
      <AuditTrail />
    </div>
  )
}

// ---------------- Paper-trading replay ----------------
// Start a RECORDED tick session as a live paper session — a random archive
// or a specific date-time range, at 1x-20x. While the replay runs, the feed
// service drives NIFTY/SENSEX (and any other recorded symbols) from the
// recorded ticks, so the terminal + paper accounts trade a "live" market.
function ReplayManager() {
  const qc = useQueryClient()
  const { data: rec } = useQuery({ queryKey: ['tick-recorder'], queryFn: () => api.tickRecorder(), refetchInterval: 10_000 })
  const { data: st } = useQuery({ queryKey: ['replay-status'], queryFn: () => api.replayStatus(), refetchInterval: 1500 })
  const [file, setFile] = useState<string>('')
  const [random, setRandom] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)

  const sessions = rec?.sessions ?? []
  const active = st?.active

  const control = async (mode: 'start' | 'stop') => {
    setBusy(true)
    try {
      const fromTs = from ? new Date(from).getTime() : null
      const toTs = to ? new Date(to).getTime() : null
      const r = await api.replayControl({ mode, file: file || null, random: random && !file, fromTs, toTs, speed })
      if ((r as { ok?: boolean }).ok === false && 'error' in r) throw new Error((r as { error?: string }).error)
      toast.success(mode === 'start' ? `Replay started — ${r.file} (${r.total} ticks @ ${r.speed}x)` : 'Replay stopped')
      await qc.invalidateQueries({ queryKey: ['replay-status'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Replay control failed')
    }
    setBusy(false)
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Radio className={`h-4 w-4 ${active ? 'text-[#00c896]' : 'text-muted-foreground'}`} />
        <div className="font-bold text-sm">Paper Trading Replay</div>
        {active && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-up text-[#00c896] font-bold animate-pulse">PLAYING {st?.speed}x</span>
        )}
        <div className="flex-1" />
        {active && (
          <span className="text-[10px] text-muted-foreground tabular">
            {st?.played}/{st?.total} ticks · {st?.progressPct}% · {(st?.symbols ?? []).join(', ')}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Load a recorded tick session and play it as a live session — paper accounts trade the replayed market.
        Pick a specific archive or let the system choose a random one, optionally bounded by a date-time range.
      </p>
      <div className="grid md:grid-cols-2 gap-3">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={random && !file} onChange={e => { setRandom(e.target.checked); if (e.target.checked) setFile('') }} className="accent-[#3b82f6] h-3 w-3" />
            Random recorded session
          </label>
          <Select value={file || 'none'} onValueChange={v => { setFile(v === 'none' ? '' : v); setRandom(v === 'none') }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick a recorded session…" /></SelectTrigger>
            <SelectContent className="text-xs max-h-56">
              <SelectItem value="none">— pick a session —</SelectItem>
              {sessions.map(s => (
                <SelectItem key={s.file} value={s.file}>{s.file} · {(s.bytes / 1024).toFixed(0)} KB</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground shrink-0">Speed</span>
            <Select value={String(speed)} onValueChange={v => setSpeed(Number(v))}>
              <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="text-xs">
                {[0.5, 1, 2, 5, 10, 20].map(s => <SelectItem key={s} value={String(s)}>{s}x</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">optional date-time range (IST)</div>
          <div className="flex items-center gap-1.5">
            <Input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} className="h-8 text-xs" />
            <span className="text-muted-foreground">–</span>
            <Input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="h-8 text-xs flex-1" disabled={busy || !!active} onClick={() => control('start')}>
              Start replay
            </Button>
            <Button size="sm" variant="secondary" className="h-8 text-xs" disabled={busy || !active} onClick={() => control('stop')}>
              Stop
            </Button>
          </div>
        </div>
      </div>
      {active && st?.file && (
        <div className="text-[10px] text-muted-foreground">playing <b>{st.file}</b> since {st.startedAt ? fmtDateTime(st.startedAt) : '—'}</div>
      )}
    </div>
  )
}

// ---------------- Tick recorder (session live-feed backup) ----------------
// Every tick of the configured symbols (default NIFTY + SENSEX) is written
// to a per-session SQLite DB by the market-feed service. These archives
// power the future paper-trading / replay engine.
function TickRecorder() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['tick-recorder'], queryFn: () => api.tickRecorder(), refetchInterval: 5000 })
  const [sym, setSym] = useState('')
  if (!data) return null

  const save = async (body: { enabled?: boolean; symbols?: string[] }) => {
    try {
      await api.setTickRecorder(body)
      await qc.invalidateQueries({ queryKey: ['tick-recorder'] })
      toast.success('Tick recorder updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const addSym = () => {
    const s = sym.trim().toUpperCase()
    if (!s) return
    if (data.symbols.includes(s)) { toast.info('Symbol already recorded'); return }
    setSym('')
    void save({ symbols: [...data.symbols, s] })
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-primary" />
        <div className="font-bold text-sm">Tick Data Recorder</div>
        <span className="text-[10px] text-muted-foreground">session live-feed backup — every tick stored per session for paper trading</span>
        <div className="flex-1" />
        <span className={`text-[10px] font-bold ${data.enabled ? 'text-[#00c896]' : 'text-muted-foreground'}`}>{data.enabled ? 'RECORDING' : 'OFF'}</span>
        <Switch checked={data.enabled} onCheckedChange={v => save({ enabled: v })} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {data.symbols.map(s => (
          <span key={s} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] tabular">
            {s}
            <button
              onClick={() => save({ symbols: data.symbols.filter(x => x !== s) })}
              className="text-muted-foreground hover:text-[#ff4d5e]"
              title={`Stop recording ${s}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <div className="flex items-center gap-1">
          <Input
            value={sym}
            onChange={e => setSym(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && addSym()}
            placeholder="add symbol…"
            className="h-6 w-28 text-[10px] bg-secondary/60"
          />
          <Button size="sm" variant="secondary" className="h-6 px-2 text-[10px]" onClick={addSym}>Add</Button>
        </div>
      </div>

      {data.session && (
        <div className="text-[10px] text-muted-foreground tabular">
          current session: <b className="text-foreground">{data.session.file.split('/').pop()}</b> · {data.session.rows.toLocaleString('en-IN')} ticks · started {fmtDateTime(data.session.startedAt)}
        </div>
      )}

      {data.sessions.length > 0 && (
        <div className="rounded border border-border/60 max-h-40 overflow-y-auto">
          <table className="w-full text-[10px] tabular">
            <thead className="text-muted-foreground sticky top-0 bg-card">
              <tr>
                <th className="text-left font-medium px-2 py-1">Session DB</th>
                <th className="text-left font-medium px-2 py-1">Size</th>
                <th className="text-left font-medium px-2 py-1">Last write</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map(s => (
                <tr key={s.file} className={`border-t border-border/40 ${data.session?.file.endsWith(s.file.split('/').pop() ?? '##') ? 'bg-primary/10' : ''}`}>
                  <td className="px-2 py-1">{s.file.replace('db/ticks/', '')}</td>
                  <td className="px-2 py-1">{(s.bytes / 1024).toFixed(0)} KB</td>
                  <td className="px-2 py-1 text-muted-foreground">{fmtDateTime(s.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-[9px] text-muted-foreground leading-snug">
        A new SQLite DB is created per feed session (and rolls over at the IST day boundary). Replay API: <code>/api/tickrecorder</code> — the stored ticks will feed the paper-trading engine.
      </div>
    </div>
  )
}

// ---------------- Broker accounts ----------------
// OAuth-style session model (aligned with straweb/hedging broker flows):
//  · ICICI Breeze — API key (+secret) → login redirect ?apisession= →
//    customerdetails exchange → session_key
//  · Dhan — app_id/app_secret → generate-consent → consentApp-login →
//    consumeApp-consent (tokenId) → accessToken (or paste a direct JWT)
//  · Shoonya — api_key/client_id + secret → prism login ?code= →
//    GenAcsTok (sha256 checksum) → susertoken (or QuickAuth uid+pwd+PAN)
function AccountsManager() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts(), refetchInterval: 5000 })
  const [dlgOpen, setDlgOpen] = useState(false)
  const [form, setForm] = useState<{
    label: string; brokerType: BrokerType; clientId: string; initialCapital: string; mode: CapitalMode
    apiKey: string; secret: string; extra: string
  }>({
    label: '', brokerType: 'SIMFEED', clientId: '', initialCapital: '500000', mode: 'INITIAL_PLUS_PNL', apiKey: '', secret: '', extra: '',
  })

  const accounts = data?.accounts ?? []

  const create = async () => {
    try {
      const credentials: Record<string, string> = {}
      for (const [k, v] of Object.entries(oauthFieldsFor(form.brokerType, form))) {
        if (v?.trim()) credentials[k] = v.trim()
      }
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
      setForm({ ...form, label: '', clientId: '', apiKey: '', secret: '', extra: '' })
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
              <Field label={credFieldLabel(form.brokerType)} hint="Encrypted at rest (AES-256-GCM). OAuth session tokens are created per-day via the Session button after adding.">
                <Input value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} className="h-8" />
              </Field>
              {form.brokerType !== 'SIMFEED' && (
                <Field label={secretFieldLabel(form.brokerType)}>
                  <Input type="password" value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} className="h-8" />
                </Field>
              )}
              {extraFieldLabel(form.brokerType) && (
                <Field label={extraFieldLabel(form.brokerType)!}>
                  <Input value={form.extra} onChange={e => setForm({ ...form, extra: e.target.value })} className="h-8" />
                </Field>
              )}
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
              {a.brokerType !== 'SIMFEED' && <SessionDialog accountId={a.id} label={a.label} brokerType={a.brokerType} />}
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

/** Map the add-account form to the broker's OAuth credential schema
 *  (app credentials — session tokens are created via the Session dialog). */
function oauthFieldsFor(b: BrokerType, form: { apiKey: string; secret: string; extra: string; clientId: string }): Record<string, string> {
  switch (b) {
    case 'ICICI_BREEZE':
      return { apiKey: form.apiKey, apiSecret: form.secret }
    case 'DHAN':
      return { appId: form.apiKey, appSecret: form.secret, clientId: form.extra || form.clientId }
    case 'SHOONYA':
      return { userId: form.extra || form.clientId, apiKey: form.apiKey, apiSecret: form.secret }
    default:
      return { apiKey: form.apiKey, secret: form.secret }
  }
}
function credFieldLabel(b: BrokerType) {
  return b === 'DHAN' ? 'App ID (API key)' : b === 'SHOONYA' ? 'API key (app client_id)' : b === 'ICICI_BREEZE' ? 'API key (Breeze AppKey)' : 'API Key'
}
function secretFieldLabel(b: BrokerType) {
  return b === 'DHAN' ? 'App Secret' : b === 'SHOONYA' ? 'API Secret' : b === 'ICICI_BREEZE' ? 'API Secret' : 'Secret'
}
function extraFieldLabel(b: BrokerType): string | null {
  return b === 'DHAN' ? 'Dhan Client ID' : b === 'SHOONYA' ? 'User ID (login id)' : null
}

// ---------------- Broker session (OAuth) dialog ----------------
// Per-broker day-session creation: open the login URL → paste the
// redirect code/token → the server exchanges it for session tokens.
function SessionDialog({ accountId, label, brokerType }: { accountId: string; label: string; brokerType: string }) {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const { data: st } = useQuery({
    queryKey: ['broker-auth', accountId],
    queryFn: () => api.brokerAuthStatus(accountId),
    enabled: open,
    refetchInterval: 15_000,
  })
  const isDhan = brokerType === 'DHAN'
  const isShoonya = brokerType === 'SHOONYA'
  const isIcici = brokerType === 'ICICI_BREEZE'

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true)
    try {
      const r = await fn()
      r.ok ? toast.success(r.message) : toast.error(r.message)
      if (r.ok) { setCode(''); qc.invalidateQueries({ queryKey: ['broker-auth', accountId] }) }
    } catch (e) { toast.error(e instanceof Error ? e.message : 'failed') }
    setBusy(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-1.5 gap-1" title={`Create the ${brokerType} API session`}>
          <KeyRound className={`h-3.5 w-3.5 ${st?.hasSession ? 'text-[#00c896]' : 'text-muted-foreground'}`} />
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-popover max-w-lg">
        <DialogHeader><DialogTitle>Broker session — {label}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-xs">
          {st && (
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className={`px-1.5 py-0.5 rounded ${st.hasSession ? 'bg-up text-[#00c896]' : 'bg-secondary text-muted-foreground'}`}>
                {st.hasSession ? `session ${st.sessionMasked}` : 'no session'}
              </span>
              <span className="text-muted-foreground">{st.mode}</span>
              <span className="text-muted-foreground">· session kind: {st.sessionKind}</span>
            </div>
          )}
          <ol className="list-decimal list-inside space-y-0.5 text-[10px] text-muted-foreground">
            {(st?.instructions ?? []).map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {st?.loginUrl && (
            <div className="flex items-center gap-1.5">
              <a href={st.loginUrl} target="_blank" rel="noreferrer" className="text-[10px] underline text-[#4dd0e1] truncate flex-1" title={st.loginUrl}>
                {st.loginUrl}
              </a>
              <Button size="sm" variant="secondary" className="h-6 text-[10px]" onClick={() => { void navigator.clipboard?.writeText(st.loginUrl!); toast.info('Login URL copied') }}>copy</Button>
            </div>
          )}
          {isDhan && (
            <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={busy}
              onClick={() => run(() => api.brokerAuthConsent(accountId))}>
              1 · Generate consent (app_id + app_secret)
            </Button>
          )}
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground">
              {isIcici ? '2 · Paste the apisession from the redirect URL'
                : isDhan ? '3 · Paste the tokenId (or a direct access token)'
                : isShoonya ? '2 · Paste the code from the redirect URL (or use QuickAuth below)'
                : 'Paste the session token'}
            </div>
            <div className="flex gap-1.5">
              <Input value={code} onChange={e => setCode(e.target.value.trim())} placeholder="code / token…" className="h-8 text-[11px]" />
              <Button size="sm" className="h-8 text-[11px]" disabled={busy || !code}
                onClick={() => run(() => api.brokerAuthComplete(accountId, code))}>
                Create session
              </Button>
            </div>
          </div>
          {isShoonya && (
            <div className="border-t border-border pt-2 text-[10px] text-muted-foreground">
              Direct QuickAuth (no browser): save the account with User ID + API secret, then paste
              <b> pwd:factor2 </b>(password:PAN/DOB, optionally <b>:totp</b>) as the code above — e.g. <code>mypass:ABCD1</code>.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
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
