import { NextRequest, NextResponse } from 'next/server'
import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'

// ============================================================
// Active feed source API + global Live-Only switch.
// GET  -> { source, simDisabled, sources: [sim + every account] }
// POST { source?, simDisabled? }
//   · source — switch the radio (sim or a broker account id)
//   · simDisabled — admin "Live-Only" checkbox: stops the sim
//     random-walk AND refuses sandbox fills (adapters reject).
// The selected id + flag persist in the shared JSON file (the feed
// engine owns the same keys), mirrored onto BrokerAccount.
// ============================================================

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'
const FEED_SRC_FILE = path.join(process.cwd(), 'db', 'feed-source.json')

interface FeedSrcFile { source?: string; simDisabled?: boolean; updatedAt?: string }

async function readSourceFile(): Promise<FeedSrcFile> {
  try {
    return JSON.parse(await readFile(FEED_SRC_FILE, 'utf8')) as FeedSrcFile
  } catch {
    return {}
  }
}

/** read-modify-write so source + simDisabled never clobber each other */
async function writeSourceFile(patch: { source?: string; simDisabled?: boolean }) {
  try {
    const prev = await readSourceFile()
    await mkdir(path.dirname(FEED_SRC_FILE), { recursive: true })
    await writeFile(FEED_SRC_FILE, JSON.stringify({
      ...prev,
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.simDisabled !== undefined ? { simDisabled: patch.simDisabled } : {}),
      updatedAt: new Date().toISOString(),
    }, null, 2))
  } catch { /* mini-service remains the source of truth */ }
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  try {
    let source = 'sim'
    let simDisabled = false
    try {
      const r = await fetch(`${FEED_URL}/feed-source`, { signal: AbortSignal.timeout(1200), cache: 'no-store' })
      if (r.ok) {
        const j = (await r.json()) as { source?: string; simDisabled?: boolean }
        source = j.source ?? 'sim'
        simDisabled = j.simDisabled === true
      }
    } catch {
      const f = await readSourceFile()
      source = f.source ?? 'sim'
      simDisabled = f.simDisabled === true
    }
    const accounts = await db.brokerAccount.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { id: true, label: true, brokerType: true, isActive: true },
    })
    return NextResponse.json({
      source,
      simDisabled,
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
    const body = (await req.json()) as { source?: string; simDisabled?: boolean }
    const { source, simDisabled } = body
    if (source === undefined && typeof simDisabled !== 'boolean') {
      return NextResponse.json({ error: 'source or simDisabled required' }, { status: 400 })
    }
    if (source) {
      if (source !== 'sim') {
        const acc = await db.brokerAccount.findUnique({ where: { id: source }, select: { id: true, isActive: true } })
        if (!acc || !acc.isActive) return NextResponse.json({ error: 'Unknown or inactive account' }, { status: 400 })
      }
      // mirror the radio state onto accounts (exactly one live data source)
      await db.brokerAccount.updateMany({ data: { isLiveDataSource: false } })
      if (source !== 'sim') {
        await db.brokerAccount.update({ where: { id: source }, data: { isLiveDataSource: true } })
      }
    }
    // forward to the feed engine (it also purges sim data on source change);
    // fall back to the shared file if the service is down
    let ok = false
    try {
      const r = await fetch(`${FEED_URL}/feed-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(source !== undefined ? { source } : {}), ...(typeof simDisabled === 'boolean' ? { simDisabled } : {}) }),
        signal: AbortSignal.timeout(1200),
        cache: 'no-store',
      })
      ok = r.ok
    } catch { ok = false }
    if (!ok) await writeSourceFile({
      ...(source !== undefined ? { source } : {}),
      ...(typeof simDisabled === 'boolean' ? { simDisabled } : {}),
    })
    return NextResponse.json({ ok: true, ...(source !== undefined ? { source } : {}), ...(typeof simDisabled === 'boolean' ? { simDisabled } : {}) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Switch failed' }, { status: 503 })
  }
}
