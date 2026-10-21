import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { getCash } from '@brokers/database'

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const accounts = await db.brokerAccount.findMany({ include: { capital: true }, orderBy: { sortOrder: 'asc' } })
  const funds = accounts.map(a => ({
    accountId: a.id,
    label: a.label,
    brokerType: a.brokerType,
    cash: getCash(a.brokerType, a.id),
    initialCapital: a.capital?.initialCapital ?? 0,
    realizedPnl: a.capital?.realizedPnl ?? 0,
    chargesPaid: a.capital?.chargesPaid ?? 0,
    deployed: a.capital?.deployed ?? 0,
  }))
  return NextResponse.json({ funds })
}
