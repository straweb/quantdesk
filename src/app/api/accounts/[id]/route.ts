import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { encryptJson } from '@/lib/crypto'
import { resetCapital } from '@/lib/services/capital-service'
import type { CapitalMode } from '@/lib/types'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const acc = await db.brokerAccount.findUnique({ where: { id }, include: { capital: true } })
  if (!acc) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  if (body.label !== undefined) data.label = String(body.label)
  if (body.clientId !== undefined) data.clientId = body.clientId ? String(body.clientId) : null
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive)
  if (body.isOrderEnabled !== undefined) data.isOrderEnabled = Boolean(body.isOrderEnabled)
  if (body.isCopyMaster !== undefined) data.isCopyMaster = Boolean(body.isCopyMaster)
  if (body.status !== undefined) data.status = String(body.status)
  if (body.credentials !== undefined) {
    data.credentialsEnc = body.credentials && Object.keys(body.credentials).length ? encryptJson(body.credentials) : acc.credentialsEnc
  }
  if (body.isLiveDataSource !== undefined && body.isLiveDataSource) {
    // only one live data source at a time
    await db.brokerAccount.updateMany({ data: { isLiveDataSource: false } })
    data.isLiveDataSource = true
  } else if (body.isLiveDataSource === false) {
    data.isLiveDataSource = false
  }
  await db.brokerAccount.update({ where: { id }, data })

  if (body.initialCapital !== undefined || body.mode !== undefined || body.resetCapital) {
    if (acc.capital) {
      if (body.resetCapital) {
        await resetCapital(id, Number(body.initialCapital ?? acc.capital.initialCapital), (body.mode ?? acc.capital.mode) as CapitalMode)
      } else {
        await db.capitalConfig.update({
          where: { accountId: id },
          data: {
            ...(body.initialCapital !== undefined ? { initialCapital: Number(body.initialCapital) } : {}),
            ...(body.mode !== undefined ? { mode: String(body.mode) } : {}),
          },
        })
      }
    }
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req)
  if (auth) return auth
  const { id } = await params
  await db.brokerAccount.delete({ where: { id } }).catch(() => null)
  return NextResponse.json({ ok: true })
}
