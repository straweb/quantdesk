import { NextRequest, NextResponse } from 'next/server'

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'

// REST proxy: full quote + market depth
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const symbol = url.searchParams.get('symbol') ?? ''
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  try {
    const res = await fetch(`${FEED_URL}/quote?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (e) {
    return NextResponse.json({ error: `feed unavailable: ${e instanceof Error ? e.message : ''}` }, { status: 502 })
  }
}

export const dynamic = 'force-dynamic'
