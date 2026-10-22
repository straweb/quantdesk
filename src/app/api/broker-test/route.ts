import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { getAdapter, type LegContext, type SymbolMapInfo } from '@brokers/registry'
import { decryptJson } from '@/lib/crypto'
import type { BrokerType } from '@/lib/types'

// ============================================================
// Broker connectivity test — the debugging surface for "why is my
// live account not working". Runs 4 timed steps per account and
// returns exactly what happened, step by step (every underlying
// call is also tagged + written to broker_logs):
//   1. credentials present + session token saved?
//   2. adapter mode (Live / Sandbox)
//   3. getFunds → available cash
//   4. getQuote on the account's first mapped symbol → LTP
// ============================================================

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface StepResult { step: string; ok: boolean; ms: number; detail: string }

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => ({}))
  const accountId: string | undefined = body?.accountId
  if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return NextResponse.json({ error: 'account not found' }, { status: 404 })

  const steps: StepResult[] = []
  const t = (step: string, ok: boolean, ms: number, detail: string) => steps.push({ step, ok, ms, detail })

  // 1 — credentials
  let t0 = Date.now()
  const creds = decryptJson(acc.credentialsEnc)
  const hasSession = !!(creds?.sessionToken || creds?.accessToken || creds?.sessionId)
  t('credentials', !!creds && hasSession, Date.now() - t0,
    creds
      ? `saved keys: ${Object.keys(creds).join(', ')} · session ${hasSession ? 'present' : 'MISSING (create it via the Session dialog)'}`
      : 'no credentials saved — sandbox account')

  const adapter = getAdapter(acc.brokerType as BrokerType)

  // 2 — adapter mode
  t0 = Date.now()
  const mode = adapter?.modeLabel(creds) ?? 'sandbox'
  t('mode', adapter?.isLiveCapable() ?? false, Date.now() - t0, mode)

  const ctx: LegContext = {
    accountId: acc.id,
    accountLabel: acc.label,
    brokerType: acc.brokerType as never,
    credentials: creds,
    order: { side: 'BUY', qty: 0, orderType: 'MARKET', productType: 'MIS', masterOrderId: '', source: 'TEST' },
    symbolMap: { masterSymbol: '', exchange: '', instrumentType: '', lotSize: 1, brokerSymbol: '' } as SymbolMapInfo,
    ltp: 0,
  }

  // 3 — funds
  let fundsOk = false
  let fundsDetail = 'skipped (no getFunds on this adapter or sandbox account)'
  if (adapter?.getFunds && creds && hasSession) {
    t0 = Date.now()
    try {
      const f = await adapter.getFunds(ctx)
      fundsOk = Number.isFinite(f?.cash)
      fundsDetail = fundsOk ? `available cash ₹${Math.round(f.cash).toLocaleString('en-IN')}` : 'funds call returned no cash value'
    } catch (e) {
      fundsDetail = e instanceof Error ? e.message : String(e)
    }
    t('funds', fundsOk, Date.now() - t0, fundsDetail)
  } else {
    t('funds', false, 0, fundsDetail)
  }

  // 4 — quote on the first mapped symbol
  let quoteOk = false
  let quoteDetail = 'skipped (sandbox account)'
  if (adapter?.getQuote && creds && hasSession) {
    const mapping = await db.symbolMapping.findFirst({
      where: { brokerType: acc.brokerType },
      include: { master: true },
      orderBy: { id: 'asc' },
    })
    if (mapping) {
      ctx.symbolMap = {
        masterSymbol: mapping.master.symbol,
        exchange: mapping.master.exchange,
        instrumentType: mapping.master.instrumentType,
        lotSize: mapping.master.lotSize,
        brokerSymbol: mapping.brokerSymbol,
        brokerToken: mapping.brokerToken ?? mapping.brokerSymbol,
      }
      t0 = Date.now()
      try {
        const q = await adapter.getQuote(ctx, ctx.symbolMap.brokerToken ?? ctx.symbolMap.brokerSymbol)
        quoteOk = !!q?.ltp
        quoteDetail = quoteOk
          ? `${mapping.master.symbol} LTP ${q.ltp}${q.bid ? ` · bid ${q.bid}` : ''}${q.ask ? ` · ask ${q.ask}` : ''}`
          : `no LTP in the response for ${mapping.master.symbol} (${ctx.symbolMap.brokerToken}) — check mapping / market hours`
      } catch (e) {
        quoteDetail = e instanceof Error ? e.message : String(e)
      }
      t('quote', quoteOk, Date.now() - t0, quoteDetail)
    } else {
      t('quote', false, 0, 'no symbol mapping saved for this broker — run Master Contracts sync')
    }
  } else {
    t('quote', false, 0, quoteDetail)
  }

  const ok = steps.filter(s => s.step === 'credentials' || s.step === 'mode').every(s => s.ok)
    && (fundsOk || quoteOk) // at least one live call succeeded
  return NextResponse.json({
    ok,
    accountId: acc.id,
    label: acc.label,
    brokerType: acc.brokerType,
    steps,
    hint: !ok
      ? 'Open Admin → Broker Diagnostics for the per-call logs; fix the first failing step.'
      : 'All live calls succeeded — this account can trade and feed real data.',
  })
}
