'use client'

import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, SquareTerminal, Settings2, Bot, LogOut, CircleDot, Trophy, LayoutDashboard, Link2, Unlink, Radio } from 'lucide-react'
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
import { useSyncChannel, type SyncCore } from './lib/sync'
import { TerminalView } from './terminal-view'
import { AdminView } from './admin/admin-view'
import { StrategyView } from './strategy/strategy-view'
import { DashboardView } from './dashboard/dashboard-view'
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

// broker icon glyph + tint — replaces the full account label on the chip
// (saves horizontal space; the label lives in the tooltip + popover)
const BROKER_ICON: Record<string, { glyph: string; cls: string }> = {
  SIMFEED: { glyph: '⚡', cls: 'bg-slate-500/25 text-slate-300' },
  DHAN: { glyph: 'D', cls: 'bg-[#3b82f6]/25 text-[#60a5fa]' },
  SHOONYA: { glyph: 'S', cls: 'bg-[#8b5cf6]/25 text-[#a78bfa]' },
  ICICI_BREEZE: { glyph: 'iB', cls: 'bg-[#f97316]/25 text-[#fb923c]' },
}
function brokerIcon(brokerType: string) {
  return BROKER_ICON[brokerType] ?? { glyph: brokerType.slice(0, 1) ?? '?', cls: 'bg-secondary text-muted-foreground' }
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
    // debug/E2E hook (harmless in prod)
    ;(window as unknown as { __qdStore?: typeof useTerminal }).__qdStore = useTerminal
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
            ['dashboard', 'Dashboard', LayoutDashboard],
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
        <SessionStatsChip />

        <div className="flex items-center gap-2 text-[10px]">
          <FeedChip up={feedUp} />
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
        {view === 'dashboard' && <DashboardView />}
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
  // realtime: sync:core pushes accounts every 1s (fallback: REST when the
  // feed socket has never delivered a payload)
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.accounts(),
    enabled: !sync,
    refetchInterval: 3000,
  })
  const accounts: AccountRow[] = sync?.accounts
    ? (sync.accounts as unknown as AccountRow[])
    : (data?.accounts ?? [])
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
  const [capital, setCapital] = useState(String(acc.initialCapitalFixed ?? acc.initialCapital))
  const [pct, setPct] = useState(String(acc.capitalPct ?? 100))
  const [base, setBase] = useState<'FIXED' | 'AVAILABLE_CASH_PCT'>(acc.capitalBase ?? 'FIXED')
  const [mode, setMode] = useState<CapitalMode>(acc.mode ?? 'INITIAL_PLUS_PNL')
  const [busy, setBusy] = useState(false)

  // (re)seed the editor fields each time the popover opens — avoids the
  // setState-in-effect cascade lint rule
  const openEditor = (next: boolean) => {
    setOpen(next)
    if (next) {
      setCapital(String(acc.initialCapitalFixed ?? acc.initialCapital))
      setPct(String(acc.capitalPct ?? 100))
      setBase(acc.capitalBase ?? 'FIXED')
      setMode(acc.mode ?? 'INITIAL_PLUS_PNL')
    }
  }

  const toggleEnabled = async (next: boolean) => {
    try {
      await api.patchAccount(acc.id, { isOrderEnabled: next })
      await qc.invalidateQueries({ queryKey: ['accounts'] })
      toast.success(`${acc.label} order routing ${next ? 'enabled' : 'disabled'}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const cash = acc.availableCash ?? null
  const pctPreview = base === 'AVAILABLE_CASH_PCT' && cash != null ? Math.max(0, cash * ((Number(pct) || 0) / 100)) : null

  const save = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = { mode, capitalBase: base }
      if (base === 'AVAILABLE_CASH_PCT') {
        body.capitalPct = Math.min(100, Math.max(0, Number(pct) || 0))
      } else {
        body.initialCapital = Number(capital) || 0
      }
      await api.patchAccount(acc.id, body)
      await qc.invalidateQueries({ queryKey: ['accounts'] })
      await qc.invalidateQueries({ queryKey: ['funds'] })
      const desc = base === 'AVAILABLE_CASH_PCT'
        ? `${body.capitalPct}% of available cash${cash != null ? ` (₹${fmtCompact(pctPreview ?? 0)})` : ''}`
        : fmtCompact(Number(capital) || 0)
      toast.success(`${acc.label} capital updated — ${desc} · ${MODE_SHORT[mode]}`)
      setOpen(false)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    setBusy(false)
  }

  return (
    <Popover open={open} onOpenChange={openEditor}>
      <PopoverTrigger asChild>
        <button
          className={`flex items-center gap-1 h-6 pl-1 pr-1.5 rounded-full border transition-colors ${
            acc.isOrderEnabled
              ? 'border-[#00c896]/40 bg-up text-foreground hover:bg-up/70'
              : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground'
          }`}
          title={`${acc.label} (${acc.brokerType}) — usable ${fmtCompact(acc.usableCapital)} · ${acc.capitalBase === 'AVAILABLE_CASH_PCT' ? `${acc.capitalPct}% of available cash` : 'fixed ₹ capital'} · click to manage capital sizing`}
        >
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${acc.isOrderEnabled ? 'bg-[#00c896]' : 'bg-muted-foreground/50'}`} />
          <span className={`h-4 w-4 rounded text-[8px] font-bold grid place-items-center shrink-0 ${brokerIcon(acc.brokerType).cls}`}>
            {brokerIcon(acc.brokerType).glyph}
          </span>
          <span className="tabular font-bold text-[9px]">{fmtCompact(acc.usableCapital)}</span>
          {acc.capitalBase === 'AVAILABLE_CASH_PCT' && (
            <span className="text-[8px] font-bold text-[#e0a63f] tabular">{acc.capitalPct}%</span>
          )}
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
          <div className="text-[9px] text-muted-foreground">Capital source</div>
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => setBase('FIXED')}
              className={`px-2 py-1 rounded text-[10px] font-semibold border ${base === 'FIXED' ? 'bg-primary/20 border-primary/50 text-foreground' : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground'}`}
            >Fixed ₹</button>
            <button
              onClick={() => setBase('AVAILABLE_CASH_PCT')}
              className={`px-2 py-1 rounded text-[10px] font-semibold border ${base === 'AVAILABLE_CASH_PCT' ? 'bg-primary/20 border-primary/50 text-foreground' : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground'}`}
            >% of cash</button>
          </div>
        </div>
        {base === 'FIXED' ? (
          <div className="space-y-1">
            <div className="text-[9px] text-muted-foreground">Capital size (₹)</div>
            <Input
              value={capital}
              onChange={e => setCapital(e.target.value.replace(/[^0-9.]/g, ''))}
              className="h-7 text-[11px] tabular"
            />
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[9px] text-muted-foreground">
              <span>Share of available cash</span>
              {cash != null && <span className="tabular">cash {fmtCompact(cash)}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                value={pct}
                onChange={e => setPct(e.target.value.replace(/[^0-9.]/g, ''))}
                className="h-7 text-[11px] tabular w-20"
              />
              <span className="text-muted-foreground">%</span>
              {pctPreview != null && (
                <span className="ml-auto tabular font-bold text-[#00c896]">= {fmtCompact(pctPreview)}</span>
              )}
            </div>
            <div className="text-[8px] text-muted-foreground leading-snug">Recomputed live from the account&apos;s available cash on every sizing call — tracks the real balance (sizing mode is bypassed; PnL is already inside the cash).</div>
          </div>
        )}
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

// ------------------------------------------------------------
// Session stats chip — win rate + points captured this session,
// with a per-account breakdown popover.
// ------------------------------------------------------------
interface SessionStats {
  winRate: number | null
  pts: number
  realized: number
  unrealized: number
  net: number
  closes: number
  wins: number
  trades: number
  charges: number
  perAccount: { accountId: string; label: string; brokerType: string; trades: number; closes: number; wins: number; pts: number; realized: number; unrealized: number; charges: number }[]
  topSymbols: { symbol: string; pts: number }[]
}

function SessionStatsChip() {
  // realtime: sync:core carries the same session payload computed in the
  // feed service (win rate / pts / per-account) — REST fallback if absent
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data: rest } = useQuery({
    queryKey: ['session-stats'],
    queryFn: () => api.sessionStats(),
    enabled: !sync,
    refetchInterval: 6000,
  })
  const data = sync?.session ?? rest
  if (!data) return null
  const wr = data.winRate
  const pos = data.pts >= 0
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1 px-1.5 py-1 rounded border border-border bg-card text-[10px] hover:bg-secondary/60 transition-colors"
          title="Session performance — win rate + net points captured (click for per-account breakdown)"
        >
          <Trophy className={`h-3 w-3 ${pos ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`} />
          <span className="tabular font-bold">{wr != null ? `${wr.toFixed(0)}%` : '—'}</span>
          <span className="text-muted-foreground">WR</span>
          <span className="w-px h-3 bg-border" />
          <span className={`tabular font-bold ${pos ? 'term-up' : 'term-down'}`}>
            {pos ? '+' : ''}{data.pts.toFixed(1)} pts
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 text-[11px] space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-wide text-muted-foreground">current session</span>
          <span className="text-[9px] text-muted-foreground">{data.trades} trades · {data.closes} closed</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded bg-secondary/50 p-1.5">
            <div className="text-[8px] text-muted-foreground">WIN RATE</div>
            <div className="tabular font-bold text-sm">{wr != null ? `${wr.toFixed(1)}%` : '—'}</div>
            <div className="text-[8px] text-muted-foreground">{data.wins}W / {data.closes - data.wins}L</div>
          </div>
          <div className="rounded bg-secondary/50 p-1.5">
            <div className="text-[8px] text-muted-foreground">NET POINTS</div>
            <div className={`tabular font-bold text-sm ${data.pts >= 0 ? 'term-up' : 'term-down'}`}>{data.pts >= 0 ? '+' : ''}{data.pts.toFixed(1)}</div>
            <div className={`text-[8px] tabular ${data.net >= 0 ? 'term-up' : 'term-down'}`}>net {fmtCompact(data.net)}</div>
          </div>
        </div>
        <div className="flex gap-3 text-[9px] text-muted-foreground tabular">
          <span>realized <b className={data.realized >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(data.realized)}</b></span>
          <span>unrealized <b className={data.unrealized >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(data.unrealized)}</b></span>
          <span>charges {fmtCompact(data.charges)}</span>
        </div>
        {data.perAccount.length > 0 && (
          <div className="border-t border-border/60 pt-1.5 space-y-0.5">
            <div className="text-[8px] uppercase tracking-wide text-muted-foreground">per account (net = realized + unrealized)</div>
            {data.perAccount.map(a => {
              const net = a.realized + a.unrealized
              return (
                <div key={a.accountId} className="flex items-center justify-between text-[10px]">
                  <span className="flex items-center gap-1 min-w-0">
                    <span className={`h-3 w-3 rounded text-[7px] font-bold grid place-items-center shrink-0 ${brokerIcon(a.brokerType).cls}`}>{brokerIcon(a.brokerType).glyph}</span>
                    <span className="truncate text-muted-foreground">{a.label}</span>
                  </span>
                  <span className="tabular shrink-0">
                    <span className="text-muted-foreground mr-1.5">{a.closes ? `${((a.wins / a.closes) * 100).toFixed(0)}%` : '—'}</span>
                    <b className={net >= 0 ? 'term-up' : 'term-down'}>{fmtCompact(net)}</b>
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {data.topSymbols.length > 0 && (
          <div className="border-t border-border/60 pt-1.5">
            <div className="text-[8px] uppercase tracking-wide text-muted-foreground mb-0.5">pts by symbol</div>
            <div className="flex flex-wrap gap-1">
              {data.topSymbols.map(s => (
                <span key={s.symbol} className={`px-1 py-0.5 rounded text-[9px] tabular ${s.pts >= 0 ? 'bg-up text-[#00c896]' : 'bg-down text-[#ff4d5e]'}`}>
                  {s.symbol} {s.pts >= 0 ? '+' : ''}{s.pts.toFixed(1)}
                </span>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ------------------------------------------------------------
// Feed status chip — click to see / switch the market-data
// source. Radio semantics: exactly ONE feed source is active
// (Sim built-in or one broker account's feed adapter).
// Round-8: each account row carries ICON BUTTONS for
// connect / disconnect (account active state) and live feed
// enable / disable (set as the active source or fall back to
// sim), plus the account's live PnL and capital.
// ------------------------------------------------------------
function FeedChip({ up }: { up: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const { data } = useQuery({ queryKey: ['feed-source'], queryFn: () => api.feedSource(), refetchInterval: 8000 })
  // realtime PnL / capital / connection state straight from sync:core
  const sync = useSyncChannel<SyncCore>('sync:core')
  const { data: restAccs } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.accounts(),
    enabled: !sync,
    refetchInterval: 5000,
  })
  const accounts: AccountRow[] = sync?.accounts
    ? (sync.accounts as unknown as AccountRow[])
    : (restAccs?.accounts ?? [])
  const source = data?.source ?? 'sim'
  const sources = data?.sources ?? []
  const current = sources.find(s => s.id === source)
  const accById = new Map(accounts.map(a => [a.id, a]))

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['feed-source'] }),
      qc.invalidateQueries({ queryKey: ['accounts'] }),
    ])
  }

  const pick = async (id: string) => {
    if (id === source || busy) return
    setBusy(true)
    try {
      await api.setFeedSource(id)
      await refresh()
      const label = sources.find(s => s.id === id)?.label ?? id
      toast.success(`Market data source → ${label}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Switch failed')
    } finally { setBusy(false) }
  }

  const toggleAccount = async (id: string, next: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      await api.patchAccount(id, { isActive: next })
      await refresh()
      const a = accById.get(id)
      toast.success(`${a?.label ?? 'Account'} ${next ? 'connected' : 'disconnected'}${!next && source === id ? ' — feed fell back to Sim' : ''}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally { setBusy(false) }
  }

  const toggleFeed = async (id: string) => {
    // if this account already feeds the terminal -> disable (back to sim);
    // otherwise enable it as the active source
    await pick(source === id ? 'sim' : id)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`flex items-center gap-1 px-1.5 py-1 rounded border transition-colors ${
            up ? 'border-[#00c896]/30 bg-up/40 text-[#00c896] hover:bg-up/60' : 'border-[#ff4d5e]/30 bg-down/40 text-[#ff4d5e] hover:bg-down/60'
          }`}
          title="Market data source — click to view / switch · per-account connect + feed controls inside"
        >
          <CircleDot className={`h-3 w-3 ${up ? 'pulse-dot' : ''}`} />
          <span className="font-bold">FEED {up ? 'LIVE' : 'DOWN'}</span>
          <span className="text-muted-foreground">·</span>
          <span className="max-w-[110px] truncate text-foreground/80">{current?.label ?? 'Sim Feed'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-2 text-[11px] space-y-1">
        <div className="px-1 pb-1 text-[9px] text-muted-foreground leading-snug">
          Market data source — one feed active at a time. Each account row: connect/disconnect the account, enable/disable its live feed, live PnL &amp; capital.
        </div>
        {sources.map(s => {
          const acc = s.id === 'sim' ? null : accById.get(s.id)
          const isSrc = s.id === source
          return (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => pick(s.id)}
              onKeyDown={e => { if (e.key === 'Enter') pick(s.id) }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors cursor-pointer ${
                isSrc ? 'bg-primary/20 border border-primary/50' : 'hover:bg-secondary border border-transparent'
              } ${acc && !acc.isActive ? 'opacity-60' : ''}`}
            >
              <span className={`h-2.5 w-2.5 rounded-full border shrink-0 flex items-center justify-center ${
                isSrc ? 'border-primary' : 'border-muted-foreground/40'
              }`}>
                {isSrc && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </span>
              <span className={`h-4 w-4 rounded text-[8px] font-bold grid place-items-center shrink-0 ${s.id === 'sim' ? 'bg-slate-500/25 text-slate-300' : brokerIcon(s.brokerType ?? '').cls}`}>
                {s.id === 'sim' ? '⚡' : brokerIcon(s.brokerType ?? '').glyph}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate font-medium">{s.label}</span>
                  {acc && <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${acc.isActive ? 'bg-[#00c896]' : 'bg-[#ff4d5e]'}`} title={acc.isActive ? 'connected' : 'disconnected'} />}
                </span>
                {acc ? (
                  <span className="flex items-center gap-2 text-[8px] tabular mt-0.5">
                    <span className="uppercase tracking-wide text-muted-foreground">{s.brokerType}</span>
                    <span className={acc.realizedPnl >= 0 ? 'term-up' : 'term-down'}>
                      PnL {acc.realizedPnl >= 0 ? '+' : ''}{fmtCompact(acc.realizedPnl)}
                    </span>
                    <span className="text-muted-foreground">cap <b className="text-foreground">{fmtCompact(acc.usableCapital)}</b></span>
                    {acc.capitalBase === 'AVAILABLE_CASH_PCT' && <span className="text-[#e0a63f] font-bold">{acc.capitalPct}%</span>}
                  </span>
                ) : (
                  <span className="block text-[8px] text-muted-foreground uppercase tracking-wide">built-in synthetic feed</span>
                )}
              </span>
              {acc && (
                <span className="flex items-center gap-0.5 shrink-0">
                  {/* connect / disconnect the account itself */}
                  <button
                    onClick={e => { e.stopPropagation(); toggleAccount(acc.id, !acc.isActive) }}
                    disabled={busy}
                    title={acc.isActive ? 'Disconnect account' : 'Connect account'}
                    className={`p-1 rounded border transition-colors ${
                      acc.isActive
                        ? 'border-[#00c896]/40 text-[#00c896] hover:bg-[#00c896]/20'
                        : 'border-[#ff4d5e]/40 text-[#ff4d5e] hover:bg-[#ff4d5e]/20'
                    }`}
                  >
                    {acc.isActive ? <Link2 className="h-3 w-3" /> : <Unlink className="h-3 w-3" />}
                  </button>
                  {/* live feed enable / disable for this account */}
                  <button
                    onClick={e => { e.stopPropagation(); toggleFeed(acc.id) }}
                    disabled={busy}
                    title={isSrc ? 'Disable this account feed (back to Sim)' : 'Enable this account as the live feed'}
                    className={`p-1 rounded border transition-colors ${
                      isSrc
                        ? 'border-primary/60 text-primary bg-primary/15'
                        : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
                    }`}
                  >
                    <Radio className={`h-3 w-3 ${isSrc ? 'pulse-dot' : ''}`} />
                  </button>
                </span>
              )}
              {s.id === 'sim' && isSrc && <span className="text-[8px] font-bold text-primary shrink-0">ACTIVE</span>}
            </div>
          )
        })}
        <div className="px-1 pt-1 text-[8px] text-muted-foreground leading-snug">
          Disconnecting the account that is feeding the terminal falls back to Sim ticks automatically. Broker feeds stream via their adapter websocket when connected; the sandbox falls back to sim ticks so charts never go dark.
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
