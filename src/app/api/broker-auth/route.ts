import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { encryptJson } from '@/lib/crypto'
import { authStart, authComplete, dhanGenerateConsent } from '@brokers/auth'
import { credsFor, getAdapter } from '@brokers/registry'
import type { BrokerType } from '@/lib/types'

// ============================================================
// Broker session auth — OAuth-style app-credential session flows
// for the live brokers (ICICI Breeze / Dhan / Shoonya), matching
// the straweb/hedging broker/*/api/auth_api.py patterns.
//   GET  ?accountId=   → flow descriptor + current session status
//   POST { accountId, action: 'consent' | 'complete', code? }
// ============================================================

function mask(v?: string): string | null {
  if (!v) return null
  return v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const accountId = req.nextUrl.searchParams.get('accountId')
  if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return NextResponse.json({ error: 'account not found' }, { status: 404 })
  const creds = credsFor(acc.credentialsEnc)
  const adapter = getAdapter(acc.brokerType as BrokerType)
  const flow = authStart(acc.brokerType, acc.id, creds)
  return NextResponse.json({
    accountId: acc.id,
    label: acc.label,
    brokerType: acc.brokerType,
    sessionKind: adapter?.sessionKind?.() ?? 'none',
    hasSession: !!(creds?.sessionToken || creds?.accessToken || creds?.sessionId),
    sessionMasked: mask(creds?.sessionToken ?? creds?.accessToken ?? creds?.sessionId ?? undefined),
    userId: creds?.userId ?? acc.clientId ?? null,
    liveCapable: adapter?.isLiveCapable() ?? false,
    mode: adapter?.modeLabel(creds) ?? 'sandbox',
    ...flow,
  })
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const body = await req.json().catch(() => null)
  const accountId: string | undefined = body?.accountId
  const action: string = body?.action ?? 'complete'
  if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
  const acc = await db.brokerAccount.findUnique({ where: { id: accountId } })
  if (!acc) return NextResponse.json({ error: 'account not found' }, { status: 404 })
  const creds = credsFor(acc.credentialsEnc) ?? {}

  if (action === 'consent') {
    // Dhan step-1 (other brokers expose a static login URL from GET)
    if (acc.brokerType !== 'DHAN') return NextResponse.json({ error: 'consent flow only applies to Dhan' }, { status: 400 })
    const r = await dhanGenerateConsent(acc.id, creds)
    return NextResponse.json(r)
  }

  if (action === 'complete') {
    const r = await authComplete(acc.brokerType, acc.id, creds, String(body?.code ?? ''))
    if (r.ok && r.credentials) {
      await db.brokerAccount.update({
        where: { id: acc.id },
        data: { credentialsEnc: encryptJson(r.credentials) },
      })
    }
    return NextResponse.json(r)
  }

  return NextResponse.json({ error: `unknown action ${action}` }, { status: 400 })
}
