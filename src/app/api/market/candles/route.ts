import { NextRequest, NextResponse } from 'next/server'

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'

// REST proxy: candle history from the feed service
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const symbol = url.searchParams.get('symbol') ?? ''
  const tf = url.searchParams.get('tf') ?? '5m'
  const limit = url.searchParams.get('limit') ?? '500'
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  try {
    const res = await fetch(`${FEED_URL}/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&limit=${encodeURIComponent(limit)}`, {
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (e) {
    return NextResponse.json({ error: `feed service unavailable: ${e instanceof Error ? e.message : ''}` }, { status: 502 })
  }
}

export const dynamic = 'force-dynamic'
