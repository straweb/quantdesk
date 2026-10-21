import type { BrokerAdapter, LegContext, OrderLegResult } from '../registry'
import { registerAdapter } from '../registry'
import { applyFill, rejectOrder } from '../execution'
import { logBroker } from '../database'

// ============================================================
// Shoonya (Finvasia) broker plugin — Noren REST API.
// Live mode: POST /PlaceOrder with jKey session token.
// Symbol format: NSE|RELIANCE-EQ, NFO|NIFTY28OCT25C24500
// Sandbox mode: sandbox engine fallback (sim LTP), flagged.
// ============================================================

const BASE = 'https://api.shoonya.com/NorenWClientTP'

function norenSymbol(ctx: LegContext): string {
  const m = ctx.symbolMap
  if (m.exchange === 'NFO') return m.brokerSymbol
  if (m.exchange === 'BSE') return `BSE|${m.brokerSymbol}`
  return `NSE|${m.brokerSymbol}`
}

const shoonyaAdapter: BrokerAdapter = {
  brokerType: 'SHOONYA',
  isLiveCapable: () => true,

  mapSymbol(master) {
    // Noren format: SYM<DD><MMM><YY><C/P><STRIKE>
    const mons = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
    let brokerSymbol = master.instrumentType === 'EQ' ? `${master.symbol}-EQ` : master.symbol
    if (master.expiry) {
      const [y, m, d] = master.expiry.split('-')
      const expPart = `${d}${mons[parseInt(m) - 1]}${y.slice(2)}`
      if (master.instrumentType === 'FUT') brokerSymbol = `${master.symbol}${expPart}FUT`
      else if (master.instrumentType === 'CE' || master.instrumentType === 'PE')
        brokerSymbol = `${master.symbol}${expPart}${master.optionType}${master.strike}`
    }
    return { brokerSymbol, brokerToken: brokerSymbol }
  },

  modeLabel(creds) {
    return creds?.sessionId ? 'Live (Noren API)' : 'Sandbox (no session token)'
  },

  async placeOrder(ctx: LegContext): Promise<OrderLegResult> {
    const units = ctx.order.qty * ctx.symbolMap.lotSize
    if (ctx.credentials?.sessionId) {
      try {
        const res = await fetch(`${BASE}/PlaceOrder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid: ctx.credentials.userId ?? '',
            actid: ctx.credentials.userId ?? '',
            prarr: 'NON-COL',
            trantype: ctx.order.side === 'BUY' ? 'B' : 'S',
            prd: ctx.order.productType,
            exch: ctx.symbolMap.exchange,
            tsym: norenSymbol(ctx),
            qty: units,
            prc: ctx.order.limitPrice ? ctx.order.limitPrice.toFixed(2) : '0',
            prd_type: ctx.order.orderType === 'LIMIT' ? 'L' : ctx.order.orderType === 'SL' ? 'SL' : ctx.order.orderType === 'SL-M' ? 'SL-M' : 'MKT',
            trgprc: ctx.order.triggerPrice?.toFixed(2) ?? undefined,
            ret: 'DAY',
            remarks: (ctx.order.source + (ctx.order.strategyId ? ':' + ctx.order.strategyId : '')).slice(0, 28),
          }),
          signal: AbortSignal.timeout(4000),
        })
        const data = (await res.json()) as { stat?: string; norenordno?: string; emsg?: string }
        if (data.stat === 'Ok' && data.norenordno) {
          logBroker('SHOONYA', ctx.accountId, `LIVE order ${data.norenordno} ${ctx.order.side} ${units} ${norenSymbol(ctx)}`)
          return {
            accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'SHOONYA',
            brokerOrderId: data.norenordno, status: 'OPEN', qty: ctx.order.qty, message: 'Live order accepted by Shoonya',
          }
        }
        logBroker('SHOONYA', ctx.accountId, `API error: ${data.emsg ?? res.status}`, 'WARN')
      } catch {
        logBroker('SHOONYA', ctx.accountId, 'API unreachable — sandbox fallback', 'WARN')
      }
    }
    if (!ctx.credentials?.sessionId) {
      rejectOrder(ctx, 'Sandbox fill (no live credentials)')
    }
    const slip = ctx.ltp * 0.0003
    const price = ctx.order.side === 'BUY' ? ctx.ltp + slip : ctx.ltp - slip
    const fill = applyFill(ctx, price)
    return {
      accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'SHOONYA',
      brokerOrderId: fill.brokerOrderId, status: 'FILLED', qty: ctx.order.qty,
      price: fill.fillPrice, message: 'SANDBOX fill (Shoonya unreachable/no token)', sandbox: true,
    }
  },

  async cancelOrder(ctx, brokerOrderId) {
    if (ctx.credentials?.sessionId) {
      try {
        const res = await fetch(`${BASE}/CancelOrder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid: ctx.credentials.userId ?? '',
            norenordno: brokerOrderId,
          }),
          signal: AbortSignal.timeout(3000),
        })
        const data = (await res.json()) as { stat?: string }
        if (data.stat === 'Ok') return { ok: true }
      } catch { /* sandbox */ }
    }
    return { ok: true, message: 'Sandbox cancel attempted' }
  },
}

registerAdapter(shoonyaAdapter)
export default shoonyaAdapter
