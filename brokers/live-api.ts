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
