// Next.js instrumentation — runs once when the server boots.
// Bootstraps master DB, starts the strategy scheduler, the resting-order
// monitor, and a watchdog that keeps the market-feed mini-service alive
// (the feed service in turn watchdogs this dev server — mutual recovery).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { bootstrap } = await import('./lib/services/bootstrap-service')
  const { ensureStrategyScheduler } = await import('./lib/services/strategy-engine')
  const { ensureOrderMonitor } = await import('./lib/services/order-monitor')

  bootstrap()
    .then(() => console.log('[instrumentation] bootstrap complete'))
    .catch(e => console.error('[instrumentation] bootstrap error:', e))

  ensureStrategyScheduler()
  ensureOrderMonitor()
  ensureFeedWatchdog()
}

/** Respawn the market-feed mini-service if :3004 goes dark, then re-push the
 *  symbol universe (a fresh feed only knows the default 8-symbol universe). */
function ensureFeedWatchdog() {
  const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'
  const g = globalThis as unknown as { __feedWatchBusy?: boolean; __feedWatchTimer?: ReturnType<typeof setInterval> }
  if (g.__feedWatchTimer) return // hot-reload safe: single owner

  async function feedHealthy(): Promise<boolean> {
    try {
      const r = await fetch(`${FEED_URL}/health`, { signal: AbortSignal.timeout(1500), cache: 'no-store' })
      return r.ok
    } catch {
      return false
    }
  }

  g.__feedWatchTimer = setInterval(() => {
    if (g.__feedWatchBusy) return
    void (async () => {
      if (await feedHealthy()) return
      g.__feedWatchBusy = true
      console.warn('[instrumentation] market-feed :3004 down — respawning…')
      try {
        const { spawn } = await import('child_process')
        const path = await import('path')
        const child = spawn('bun', ['--hot', 'index.ts'], {
          cwd: path.join(process.cwd(), 'mini-services', 'market-feed'),
          detached: true,
          stdio: 'inherit',
          // the Next dev process env carries PORT=3000 which would hijack the
          // feed's socket.io port — pin the feed's ports explicitly
          env: { ...process.env, PORT: '3003', REST_PORT: '3004' },
        })
        child.unref()
        child.on('error', e => console.error('[instrumentation] feed spawn error:', e.message))
        // wait for the feed to boot, then re-push the full symbol universe
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1000))
          if (await feedHealthy()) break
        }
        if (await feedHealthy()) {
          const { db } = await import('./lib/db')
          const { publishUniverseToFeed } = await import('./lib/services/symbol-service')
          const rows = await db.symbolMaster.findMany({
            select: { symbol: true, basePrice: true, lotSize: true, instrumentType: true },
          })
          await publishUniverseToFeed(rows)
          console.log(`[instrumentation] market-feed respawned — universe re-published (${rows.length} symbols)`)
        }
      } catch (e) {
        console.error('[instrumentation] feed respawn failed:', e)
      } finally {
        setTimeout(() => { g.__feedWatchBusy = false }, 10_000)
      }
    })()
  }, 10_000)
}
