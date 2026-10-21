// Next.js instrumentation — runs once when the server boots.
// Bootstraps master DB, starts the strategy scheduler.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { bootstrap } = await import('./lib/services/bootstrap-service')
  const { ensureStrategyScheduler } = await import('./lib/services/strategy-engine')

  bootstrap()
    .then(() => console.log('[instrumentation] bootstrap complete'))
    .catch(e => console.error('[instrumentation] bootstrap error:', e))

  ensureStrategyScheduler()
}
