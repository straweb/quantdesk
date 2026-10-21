import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { getChainMeta, getChainQuotes } from '@/lib/services/option-service'

// GET /api/options/chain?underlying=NIFTY&expiry=...&strikes=24500,24550
// Returns chain meta (spot, ATM, step, lot, expiries) + per-strike
// CE/PE quote rows (LTP, day high/low, change) for the requested strikes.
export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const url = new URL(req.url)
  const underlying = (url.searchParams.get('underlying') ?? '').toUpperCase()
  if (!underlying) return NextResponse.json({ error: 'underlying required' }, { status: 400 })
  const expiry = url.searchParams.get('expiry') || null
  const strikes = (url.searchParams.get('strikes') ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)

  const meta = await getChainMeta(underlying, expiry)
  if (!meta) {
    return NextResponse.json({ error: `No option contracts for ${underlying}` }, { status: 404 })
  }

  // requested strikes + ATM row (for the default CE/PE mini charts)
  const want = [...strikes]
  if (!want.includes(meta.atm)) want.push(meta.atm)
  const rows = await getChainQuotes(underlying, meta.expiry, want, meta.atm, meta.step)
  const atmRow = rows.find(r => r.strike === meta.atm) ?? null

  return NextResponse.json({ meta, rows, atmRow })
}

export const dynamic = 'force-dynamic'
