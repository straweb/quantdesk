// ============================================================
// Shared live REST plumbing for broker adapters.
// Uniform JSON fetch with timeout + normalized error handling so
// every adapter's live code paths stay small and consistent.
// ============================================================

export interface LiveRes<T> {
  ok: boolean
  status: number
  data: T | null
  error?: string
}

export async function liveFetch<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<LiveRes<T>> {
  const { timeoutMs = 4000, ...rest } = init
  try {
    const res = await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    let data: T | null = null
    try { data = (await res.json()) as T } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : String(e) }
  }
}

export function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Map a broker-native status string to the terminal's normalized status. */
export function normalizeStatus(raw: string | undefined | null): string {
  const s = (raw ?? '').toUpperCase()
  if (/TRADED|COMPLETE|EXECUT|FILLED/.test(s)) return 'FILLED'
  if (/REJECT/.test(s)) return 'REJECTED'
  if (/CANCEL/.test(s)) return 'CANCELLED'
  if (/EXPIRED/.test(s)) return 'CANCELLED'
  if (/PART|PENDING|OPEN|PLACED|NEW|TRIGGER/.test(s)) return 'OPEN'
  return s || 'OPEN'
}

// ------------------------------------------------------------
// Auth-error detection + fresh-token retry (aligned with the
// straweb/hedging websocket_proxy pattern: is_auth_error →
// get_fresh_auth_token → retry the original call once).
// ------------------------------------------------------------
export function isAuthError(status: number, body: unknown): boolean {
  if (status === 401 || status === 403) return true
  const msg = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  return /session\s*(expired|invalid|token)|invalid\s*(token|session)|auth.*fail|please.*login|jKey|token.*expire/i.test(msg)
}

/** Retry `fn` once with fresh credentials when the first attempt fails on auth. */
export async function withAuthRetry<T>(
  fn: (fresh: boolean) => Promise<T>,
  detect: (r: T) => boolean,
): Promise<T> {
  const first = await fn(false)
  if (!detect(first)) return first
  return fn(true) // second attempt — caller re-reads the session token inside
}
