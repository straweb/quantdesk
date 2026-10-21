import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { runPythonStrategy, recordPythonRun } from '@/lib/services/python-runner'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// POST /api/strategy/run — execute python strategy code in the backend.
// body: { id?: string (persisted strategy), code?: string, symbol?, tf?, bars?, dryRun? }
// The code gets an SDK: get_candles() / get_quote() pull live data from the
// websocket-fed engine, signal() fires REAL master orders (dryRun skips).
const SAMPLE = `# Example: EMA cross scalper — runs on the live websocket-fed tape
c = get_candles(SYMBOL, TF, BARS)
if len(c) < 30:
    log("not enough data yet")
else:
    def ema(vals, n):
        k = 2 / (n + 1); e = vals[0]
        for v in vals[1:]: e = v * k + e * (1 - k)
        return e
    closes = [x["c"] for x in c]
    fast = ema(closes[-30:], 9)
    slow = ema(closes[-30:], 21)
    q = get_quote(SYMBOL)
    log(f"{SYMBOL} {TF} close={closes[-1]} ema9={fast:.2f} ema21={slow:.2f} ltp={q['ltp']}")
    if fast > slow and closes[-1] > fast:
        signal("BUY", msg=f"ema cross up on {SYMBOL} {TF}")
    elif fast < slow and closes[-1] < fast:
        signal("SELL", msg=f"ema cross down on {SYMBOL} {TF}")
    else:
        log("no edge right now — standing by")
`

export async function POST(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth
  let body: { id?: string; code?: string; symbol?: string; tf?: string; bars?: number; dryRun?: boolean } = {}
  try { body = await req.json() } catch { /* empty body = sample run */ }

  let code = body.code
  if (!code && body.id) {
    const s = await db.strategy.findUnique({ where: { id: body.id }, select: { pythonCode: true, symbol: true } })
    if (s?.pythonCode) {
      code = s.pythonCode
      body.symbol = body.symbol ?? s.symbol
    }
  }
  if (!code || !code.trim()) code = SAMPLE

  const r = await runPythonStrategy({
    code,
    symbol: body.symbol,
    tf: body.tf,
    bars: body.bars,
    dryRun: body.dryRun,
  })
  void recordPythonRun(body.id ?? null, r, code)
  return NextResponse.json(r, { status: r.ok ? 200 : 200 })
}
