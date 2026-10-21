import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { encryptJson } from '@/lib/crypto'
import { BROKER_META } from '@/lib/types'
import type { BrokerType } from '@/lib/types'
import { computeUsableCapital, getCapitalState } from '@/lib/services/capital-service'
import { getPositions, getOpenOrders } from '@brokers/database'
import { bootstrap } from '@/lib/services/bootstrap-service'

export async function GET(req: NextRequest) {
  await bootstrap()
  const auth = requireAuth(req)
  if (auth) return auth

  const accounts = await db.brokerAccount.findMany({
    include: { capital: true },
    orderBy: { sortOrder: 'asc' },
  })
  const snapshots: Record<string, unknown>[] = []
  for (const a of accounts) {
    const capital = a.capital
    const state = capital ? {
      mode: capital.mode as never,
      initialCapital: capital.initialCapital,
      realizedPnl: capital.realizedPnl,
      chargesPaid: capital.chargesPaid,
      deployed: capital.deployed,
      firstTradeDone: capital.firstTradeDone,
    } : null
    snapshots.push({
      id: a.id,
      label: a.label,
      brokerType: a.brokerType,
      clientId: a.clientId,
      status: a.status,
      isActive: a.isActive,
      isLiveDataSource: a.isLiveDataSource,
      isOrderEnabled: a.isOrderEnabled,
      isCopyMaster: a.isCopyMaster,
      sortOrder: a.sortOrder,
      mode: capital?.mode ?? null,
      modeLabel: state ? capital?.mode : null,
      usableCapital: state ? computeUsableCapital(state) : 0,
      initialCapital: capital?.initialCapital ?? 0,
      realizedPnl: capital?.realizedPnl ?? 0,
      chargesPaid: capital?.chargesPaid ?? 0,
      deployed: capital?.deployed ?? 0,
      firstTradeDone: capital?.firstTradeDone ?? false,
      openPositions: getPositions(a.brokerType, a.id).filter(p => p.netQty !== 0).length,
      openOrders: getOpenOrders(a.brokerType, a.id).length,
      api: BROKER_META[a.brokerType as BrokerType]?.name ?? a.brokerType,
    })
  }
  return NextResponse.json({ accounts: snapshots })
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => null)
  if (!body?.label || !body?.brokerType) {
    return NextResponse.json({ error: 'label and brokerType are required' }, { status: 400 })
  }
  if (!Object.keys(BROKER_META).includes(body.brokerType)) {
    return NextResponse.json({ error: `brokerType must be one of ${Object.keys(BROKER_META).join(', ')}` }, { status: 400 })
  }
  const count = await db.brokerAccount.count()
  const acc = await db.brokerAccount.create({
    data: {
      label: String(body.label),
      brokerType: body.brokerType,
      clientId: body.clientId ? String(body.clientId) : null,
      credentialsEnc: body.credentials && Object.keys(body.credentials).length ? encryptJson(body.credentials) : null,
      isActive: true,
      status: 'ACTIVE',
      isOrderEnabled: Boolean(body.isOrderEnabled),
      isLiveDataSource: Boolean(body.isLiveDataSource),
      sortOrder: count,
    },
  })
  await db.capitalConfig.create({
    data: {
      accountId: acc.id,
      initialCapital: Number(body.initialCapital ?? 100000),
      mode: body.mode ?? 'INITIAL_PLUS_PNL',
    },
  })
  return NextResponse.json({ ok: true, id: acc.id })
}
