import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { cancelAllOrders } from '@/lib/services/order-router'

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  const cancelled = await cancelAllOrders()
  return NextResponse.json({ ok: true, cancelled })
}
