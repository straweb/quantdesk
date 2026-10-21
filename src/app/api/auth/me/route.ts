import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@/lib/api-auth'
import { bootstrap } from '@/lib/services/bootstrap-service'
import { feedHealth } from '@brokers/feed-client'

export async function GET(req: NextRequest) {
  await bootstrap()
  const user = currentUser(req)
  const feed = await feedHealth()
  return NextResponse.json({ user, feed: feed ? 'UP' : 'DOWN' })
}
