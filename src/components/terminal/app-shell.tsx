'use client'

import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, SquareTerminal, Settings2, Bot, LogOut, CircleDot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { api } from './lib/client-api'
import type { AccountRow } from './lib/client-api'
import { useTerminal, type AppView } from './lib/store'
import { onFeedStatus, ensureSocket } from './lib/socket'
import { TerminalView } from './terminal-view'
import { AdminView } from './admin/admin-view'
import { StrategyView } from './strategy/strategy-view'
import { CAPITAL_MODES } from '@/lib/types'
import type { CapitalMode } from '@/lib/types'

const MODE_SHORT: Record<CapitalMode, string> = {
  PROFIT_ONLY: 'Profit only',
  INITIAL_PLUS_PNL: 'Initial + PnL',
  INITIAL_WITH_LOSS_REDUCTION: 'Initial − losses',
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`
  if (abs >= 1000) return `₹${(n / 1000).toFixed(1)}k`
  return `₹${Math.round(n)}`
}

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 1000 } },
})

export function TradingTerminalApp() {
  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  )
}

function Shell() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  const [feedUp, setFeedUp] = useState(true)
  const [now, setNow] = useState('')
  const setView = useTerminal(s => s.setView)
  const view = useTerminal(s => s.view)

  useEffect(() => {
    // rehydrate persisted workspaces AFTER first render — prevents the
    // React hydration mismatch ("attributes of the server rendered HTML
    // didn't match the client properties") caused by localStorage state
    // diverging from server-rendered defaults.
    void useTerminal.persist.rehydrate()
    api.me().then(r => setUser(r.user)).catch(() => setUser(null))
    ensureSocket()
    return onFeedStatus(setFeedUp)
  }, [])

  useEffect(() => {
    const iv = setInterval(() => setNow(new Date().toLocaleTimeString('en-IN', { hour12: false })), 1000)
    return () => clearInterval(iv)
  }, [])

  if (user === undefined) {
    return <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Loading terminal…</div>
  }
  if (!user) return <LoginGate onLogin={() => api.me().then(r => setUser(r.user))} />

  return (
    <div className="h-full flex flex-col">
      {/* top bar */}
      <header className="flex items-center gap-3 px-3 h-10 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-primary" />
          <span className="text-sm font-bold tracking-tight">QuantDesk</span>
          <span className="text-[9px] text-muted-foreground mt-0.5">multi-broker terminal</span>
        </div>

        <nav className="flex items-center gap-1 ml-4">
          {([
            ['terminal', 'Terminal', SquareTerminal],
            ['strategy', 'Strategy Builder', Bot],
            ['admin', 'Admin', Settings2],
          ] as [AppView, string, typeof SquareTerminal][]).map(([v, label, Icon]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] transition-colors ${
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              <Icon className="h-3 w-3" /> {label}
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        {/* per-account capital chips — quick enable + capital sizing */}
        <CapitalChips />

        <div className="flex items-center gap-2 text-[10px]">
          <span className={`flex items-center gap-1 ${feedUp ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>
            <CircleDot className={`h-3 w-3 ${feedUp ? 'pulse-dot' : ''}`} />
            {feedUp ? 'FEED LIVE' : 'FEED DOWN'}
          </span>
          <span className="tabular text-muted-foreground">{now} IST</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => api.logout().then(() => setUser(null))}>
            <LogOut className="h-3 w-3" /> admin
          </Button>
        </div>
      </header>

      {/* body */}
      <main className="flex-1 min-h-0">
        {view === 'terminal' && <TerminalView />}
        {view === 'admin' && <AdminView />}
        {view === 'strategy' && <StrategyView />}
      </main>
    </div>
  )
}

// ------------------------------------------------------------
// Capital chips (top-right): one chip per broker account.
// Click a chip to enable/disable order routing and edit the
// account's capital sizing (initial capital + house mode).
// ------------------------------------------------------------
function CapitalChips() {
  const { data } = useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts(), refetchInterval: 3000 })
  const accounts = data?.accounts ?? []
  if (accounts.length === 0) return null
  return (
    <div className="flex items-center gap-1 max-w-[44vw] overflow-x-auto py-0.5">
      {accounts.map(a => <CapitalChip key={a.id} acc={a} />)}
    </div>
  )
}

function CapitalChip({ acc }: { acc: AccountRow }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [capital, setCapital] = useState(String(acc.initialCapital))
  const [mode, setMode] = useState<CapitalMode>(acc.mode ?? 'INITIAL_PLUS_PNL')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) { setCapital(String(acc.initialCapital)); setMode(acc.mode ?? 'INITIAL_PLUS_PNL') }
  }, [open, acc.initialCapital, acc.mode])

  const toggleEnabled = async (next: boolean) => {
    try {
      await api.patchAccount(acc.id, { isOrderEnabled: next })
      await qc.invalidateQueries({ queryKey: ['accounts'] })
      toast.success(`${acc.label} order routing ${next ? 'enabled' : 'disabled'}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const save = async () => {
    setBusy(true)
    try {
      await api.patchAccount(acc.id, { initialCapital: Number(capital) || 0, mode })
      await qc.invalidateQueries({ queryKey: ['accounts'] })
      await qc.invalidateQueries({ queryKey: ['funds'] })
      toast.success(`${acc.label} capital updated — ${fmtCompact(Number(capital) || 0)} · ${MODE_SHORT[mode]}`)
      setOpen(false)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    setBusy(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`flex items-center gap-1 h-6 px-1.5 rounded-full border text-[9px] whitespace-nowrap transition-colors ${
            acc.isOrderEnabled
              ? 'border-[#00c896]/40 bg-up text-foreground hover:bg-up/70'
              : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground'
          }`}
          title={`${acc.label} (${acc.brokerType}) — usable ${fmtCompact(acc.usableCapital)} · click to manage capital sizing`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${acc.isOrderEnabled ? 'bg-[#00c896]' : 'bg-muted-foreground/50'}`} />
          <span className="font-semibold max-w-[90px] truncate">{acc.label}</span>
          <span className="tabular font-bold">{fmtCompact(acc.usableCapital)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3 space-y-2.5 text-[11px]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-bold text-xs truncate">{acc.label}</div>
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{acc.brokerType}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[9px] text-muted-foreground">usable</div>
            <div className="tabular font-bold text-[#00c896]">{fmtCompact(acc.usableCapital)}</div>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Order routing</span>
          <Switch checked={acc.isOrderEnabled} onCheckedChange={toggleEnabled} />
        </div>
        <div className="space-y-1">
          <div className="text-[9px] text-muted-foreground">Capital size (₹)</div>
          <Input
            value={capital}
            onChange={e => setCapital(e.target.value.replace(/[^0-9.]/g, ''))}
            className="h-7 text-[11px] tabular"
          />
        </div>
        <div className="space-y-1">
          <div className="text-[9px] text-muted-foreground">Sizing mode</div>
          <Select value={mode} onValueChange={v => setMode(v as CapitalMode)}>
            <SelectTrigger className="h-7 text-[11px] w-full">
              <SelectValue>{MODE_SHORT[mode]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CAPITAL_MODES) as CapitalMode[]).map(m => (
                <SelectItem key={m} value={m} textValue={MODE_SHORT[m]} title={CAPITAL_MODES[m].detail}>
                  {MODE_SHORT[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="text-[8px] text-muted-foreground leading-snug">{CAPITAL_MODES[mode].detail}</div>
        </div>
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-[9px] text-muted-foreground">
            realized <b className={acc.realizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(acc.realizedPnl)}</b>
          </span>
          <Button size="sm" className="h-7 px-3 text-[10px]" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Apply'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function LoginGate({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin123')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      await api.login(username, password)
      onLogin()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Login failed')
    } finally { setBusy(false) }
  }

  return (
    <div className="h-full flex items-center justify-center bg-[#0b0e11]">
      <div className="w-80 rounded-lg border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <div>
            <div className="text-sm font-bold">QuantDesk Terminal</div>
            <div className="text-[10px] text-muted-foreground">Sim Feed · Dhan · Shoonya · ICICI Breeze</div>
          </div>
        </div>
        <div className="space-y-2">
          <Input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" className="h-9 text-xs" />
          <Input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password" className="h-9 text-xs"
            onKeyDown={e => e.key === 'Enter' && submit()}
          />
          {err && <div className="text-[10px] text-[#ff4d5e]">{err}</div>}
          <Button className="w-full h-9 text-xs" onClick={submit} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in as admin'}
          </Button>
          <div className="text-[9px] text-muted-foreground text-center">default credentials: admin / admin123</div>
        </div>
      </div>
    </div>
  )
}
