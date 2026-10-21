'use client'

import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Activity, SquareTerminal, Settings2, Bot, LogOut, CircleDot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from './lib/client-api'
import { useTerminal, type AppView } from './lib/store'
import { onFeedStatus, ensureSocket } from './lib/socket'
import { TerminalView } from './terminal-view'
import { AdminView } from './admin/admin-view'
import { StrategyView } from './strategy/strategy-view'

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
