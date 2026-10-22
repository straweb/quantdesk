import { NextRequest, NextResponse } from 'next/server'
import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'

// ============================================================
// Active feed source API.
// GET  -> { source, sources: [sim + every active broker account] }
// POST { source } -> switch (radio semantics: exactly one active)
// The selected id is persisted by the market-feed mini-service
// (shared JSON file) so the feed engine picks it up, and mirrored
// onto BrokerAccount.isLiveDataSource for admin visibility.
// ============================================================

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'
const FEED_SRC_FILE = path.join(process.cwd(), 'db', 'feed-source.json')

async function readSourceFile(): Promise<string | null> {
  try {
    const raw = await readFile(FEED_SRC_FILE, 'utf8')
    return (JSON.parse(raw) as { source?: string }).source ?? null
  } catch {
    return null
  }
}

async function writeSourceFile(source: string) {
  try {
    await mkdir(path.dirname(FEED_SRC_FILE), { recursive: true })
    await writeFile(FEED_SRC_FILE, JSON.stringify({ source, updatedAt: new Date().toISOString() }, null, 2))
  } catch { /* mini-service remains the source of truth */ }
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    let source = 'sim'
    try {
      const r = await fetch(`${FEED_URL}/feed-source`, { signal: AbortSignal.timeout(1200), cache: 'no-store' })
      if (r.ok) source = ((await r.json()) as { source?: string }).source ?? 'sim'
    } catch {
      source = (await readSourceFile()) ?? 'sim'
    }
    const accounts = await db.brokerAccount.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { id: true, label: true, brokerType: true, isActive: true },
    })
    return NextResponse.json({
      source,
      sources: [
        { id: 'sim', label: 'Sim Feed (built-in)', brokerType: null, isActive: true },
        // every account is listed (disconnected ones too) so the dropdown
        // can reconnect them — POST still refuses inactive sources
        ...accounts.map(a => ({ id: a.id, label: a.label, brokerType: a.brokerType as string, isActive: a.isActive })),
      ],
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'feed source unavailable' }, { status: 503 })
  }
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    const { source } = (await req.json()) as { source?: string }
    if (!source) return NextResponse.json({ error: 'source required' }, { status: 400 })
    if (source !== 'sim') {
      const acc = await db.brokerAccount.findUnique({ where: { id: source }, select: { id: true, isActive: true } })
      if (!acc || !acc.isActive) return NextResponse.json({ error: 'Unknown or inactive account' }, { status: 400 })
    }
    // forward to the feed engine; fall back to the shared file if it is down
    let ok = false
    try {
      const r = await fetch(`${FEED_URL}/feed-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
        signal: AbortSignal.timeout(1200),
        cache: 'no-store',
      })
      ok = r.ok
    } catch { ok = false }
    if (!ok) await writeSourceFile(source)

    // mirror the radio state onto accounts (exactly one live data source)
    await db.brokerAccount.updateMany({ data: { isLiveDataSource: false } })
    if (source !== 'sim') {
      await db.brokerAccount.update({ where: { id: source }, data: { isLiveDataSource: true } })
    }
    return NextResponse.json({ ok: true, source })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Switch failed' }, { status: 503 })
  }
}
