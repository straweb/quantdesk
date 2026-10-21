'use client'

import { useQuery } from '@tanstack/react-query'
import { api, fmtInr, fmtTime, fmtDateTime } from '../lib/client-api'
import { useTerminal } from '../lib/store'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useState } from 'react'

const HEAD = 'text-[9px] uppercase tracking-wide text-muted-foreground'

export function BottomPanel() {
  const tab = useTerminal(s => s.bottomTab)
  const setTab = useTerminal(s => s.setBottomTab)

  return (
    <div className="flex h-full flex-col bg-card/40">
      <div className="flex items-center gap-1 px-2 pt-1 border-b border-border">
        {([
          ['orders', 'Orders'],
          ['trades', 'Trade Book'],
          ['positions', 'Positions'],
          ['funds', 'Funds'],
          ['logs', 'Broker Logs'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1.5 text-[10px] rounded-t ${tab === k ? 'bg-card text-foreground border-x border-t border-border -mb-px' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'orders' && <OrdersTable />}
        {tab === 'trades' && <TradesTable />}
        {tab === 'positions' && <PositionsTable />}
        {tab === 'funds' && <FundsTable />}
        {tab === 'logs' && <LogsPanel />}
      </div>
    </div>
  )
}

function OrdersTable() {
  const { data } = useQuery({ queryKey: ['orders'], queryFn: () => api.orders(), refetchInterval: 2500 })
  const rows = data?.orders ?? []
  if (rows.length === 0) return <Empty text="No orders yet — place one from the order pad" />
  return (
    <table className="w-full text-[10px] tabular">
      <thead className={`${HEAD} sticky top-0 bg-card/95 backdrop-blur`}>
        <tr>
          <Th>Time</Th><Th>Account</Th><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th>
          <Th>Type</Th><Th>Status</Th><Th>Avg ₹</Th><Th>Message</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(o => (
          <tr key={o.id} className="border-b border-border/40 hover:bg-secondary/30">
            <Td>{fmtTime(o.createdAt)}</Td>
            <Td className="text-muted-foreground">{o.accountLabel}</Td>
            <Td className="font-medium">{o.symbol}</Td>
            <Td className={o.side === 'BUY' ? 'term-up' : 'term-down'}>{o.side}</Td>
            <Td>{o.qty}</Td>
            <Td className="text-muted-foreground">{o.orderType}/{o.productType}</Td>
            <Td><span className={`px-1 rounded text-[9px] ${statusCls(o.status)}`}>{o.status}</span></Td>
            <Td>{o.avgPrice ? o.avgPrice.toFixed(2) : '—'}</Td>
            <Td className="text-muted-foreground max-w-[220px] truncate">{o.message}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function TradesTable() {
  const { data } = useQuery({ queryKey: ['trades'], queryFn: () => api.trades(), refetchInterval: 3000 })
  const rows = data?.trades ?? []
  if (rows.length === 0) return <Empty text="No executed trades yet" />
  return (
    <table className="w-full text-[10px] tabular">
      <thead className={`${HEAD} sticky top-0 bg-card/95`}>
        <tr>
          <Th>Time</Th><Th>Account</Th><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th>
          <Th>Price ₹</Th><Th>Value ₹</Th><Th>Charges ₹</Th><Th>Realized ₹</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(t => (
          <tr key={t.id} className="border-b border-border/40 hover:bg-secondary/30">
            <Td>{fmtTime(t.ts)}</Td>
            <Td className="text-muted-foreground">{t.accountLabel}</Td>
            <Td className="font-medium">{t.symbol}</Td>
            <Td className={t.side === 'BUY' ? 'term-up' : 'term-down'}>{t.side}</Td>
            <Td>{t.qty}</Td>
            <Td>{t.price.toFixed(2)}</Td>
            <Td>{fmtInr(t.value)}</Td>
            <Td className="text-muted-foreground" title={t.charges ? `B ${t.charges.brokerage} STT ${t.charges.stt} Txn ${t.charges.transaction} GST ${t.charges.gst}` : ''}>{t.chargesTotal.toFixed(2)}</Td>
            <Td className={(t.realizedPnl ?? 0) >= 0 ? 'term-up' : 'term-down'}>{t.realizedPnl !== undefined ? t.realizedPnl.toFixed(2) : '—'}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PositionsTable() {
  const { data } = useQuery({ queryKey: ['positions'], queryFn: () => api.positions(), refetchInterval: 1500 })
  const rows = (data?.positions ?? []).filter(p => p.netQty !== 0)
  const totals = data?.totals
  return (
    <div>
      {totals && (
        <div className="flex gap-4 px-2 py-1 text-[10px] border-b border-border/40">
          <span className="text-muted-foreground">Open: <span className="text-foreground">{totals.openPositions}</span></span>
          <span className="text-muted-foreground">Unrealized: <span className={`tabular ${totals.unrealizedPnl >= 0 ? 'term-up' : 'term-down'}`}>{fmtInr(totals.unrealizedPnl)}</span></span>
          <span className="text-muted-foreground">Realized: <span className={`tabular ${totals.realizedPnl >= 0 ? 'term-up' : 'term-down'}`}>{fmtInr(totals.realizedPnl)}</span></span>
        </div>
      )}
      {rows.length === 0 ? <Empty text="No open positions" /> : (
        <table className="w-full text-[10px] tabular">
          <thead className={`${HEAD} sticky top-0 bg-card/95`}>
            <tr>
              <Th>Account</Th><Th>Symbol</Th><Th>Prod</Th><Th>Net Qty</Th><Th>Avg ₹</Th><Th>LTP ₹</Th><Th>Unrealized ₹</Th><Th>Realized ₹</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={`${p.accountId}-${p.symbol}-${i}`} className="border-b border-border/40 hover:bg-secondary/30">
                <Td className="text-muted-foreground">{p.accountLabel}</Td>
                <Td className="font-medium">{p.symbol}</Td>
                <Td className="text-muted-foreground">{p.productType}</Td>
                <Td className={p.netQty > 0 ? 'term-up' : 'term-down'}>{p.netQty > 0 ? '+' : ''}{p.netQty}</Td>
                <Td>{p.avgPrice.toFixed(2)}</Td>
                <Td>{p.ltp.toFixed(2)}</Td>
                <Td className={p.unrealizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtInr(p.unrealizedPnl)}</Td>
                <Td className={p.realizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtInr(p.realizedPnl)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function FundsTable() {
  const { data } = useQuery({ queryKey: ['funds'], queryFn: () => api.funds(), refetchInterval: 4000 })
  const rows = data?.funds ?? []
  return (
    <table className="w-full text-[10px] tabular">
      <thead className={`${HEAD} sticky top-0 bg-card/95`}>
        <tr>
          <Th>Account</Th><Th>Broker</Th><Th>Cash ₹</Th><Th>Initial ₹</Th><Th>Realized PnL ₹</Th><Th>Charges Paid ₹</Th><Th>Deployed ₹</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(f => (
          <tr key={f.accountId} className="border-b border-border/40 hover:bg-secondary/30">
            <Td className="font-medium">{f.label}</Td>
            <Td className="text-muted-foreground">{f.brokerType}</Td>
            <Td>{fmtInr(f.cash)}</Td>
            <Td>{fmtInr(f.initialCapital)}</Td>
            <Td className={f.realizedPnl >= 0 ? 'term-up' : 'term-down'}>{fmtInr(f.realizedPnl)}</Td>
            <Td className="text-muted-foreground">{fmtInr(f.chargesPaid)}</Td>
            <Td>{fmtInr(f.deployed)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function LogsPanel() {
  const { data: acc } = useQuery({ queryKey: ['accounts-logs'], queryFn: () => api.accounts(), refetchInterval: 8000 })
  const accounts = acc?.accounts ?? []
  const [sel, setSel] = useState<string>('')
  const active = sel || accounts[0]?.id || ''
  const { data } = useQuery({
    queryKey: ['broker-logs', active],
    queryFn: () => api.brokerLogs(active),
    refetchInterval: 2000,
    enabled: !!active,
  })
  return (
    <div className="p-2 space-y-1">
      <Select value={active} onValueChange={setSel}>
        <SelectTrigger className="h-7 w-72 text-[10px]"><SelectValue placeholder="Select account" /></SelectTrigger>
        <SelectContent>
          {accounts.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <div className="font-mono text-[10px] space-y-0.5 max-h-48 overflow-y-auto">
        {(data?.logs ?? []).map(l => (
          <div key={l.id} className="flex gap-2">
            <span className="text-muted-foreground">{fmtDateTime(l.ts)}</span>
            <span className={l.level === 'WARN' ? 'text-[#f5a623]' : l.level === 'ERROR' ? 'term-down' : 'text-foreground'}>{l.message}</span>
          </div>
        ))}
        {(data?.logs ?? []).length === 0 && <div className="text-muted-foreground">No broker activity logged yet</div>}
      </div>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium px-2 py-1 whitespace-nowrap">{children}</th>
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-1 whitespace-nowrap ${className}`}>{children}</td>
}
function statusCls(s: string) {
  switch (s) {
    case 'FILLED': return 'bg-[#00c896]/15 text-[#00c896]'
    case 'OPEN': return 'bg-[#f5a623]/15 text-[#f5a623]'
    case 'REJECTED': case 'CANCELLED': return 'bg-[#ff4d5e]/15 text-[#ff4d5e]'
    default: return 'bg-secondary text-muted-foreground'
  }
}
function Empty({ text }: { text: string }) {
  return <div className="h-full min-h-24 flex items-center justify-center text-[11px] text-muted-foreground">{text}</div>
}
