import type { BrokerAdapter, LegContext, OrderLegResult } from '../registry'
import { registerAdapter } from '../registry'
import { applyFill, rejectOrder } from '../execution'
import { logBroker } from '../database'

// ============================================================
// ICICI Direct Breeze broker plugin — Breeze REST API v1.
// Live mode: POST /orders with Authorization: Bearer <session token>
// and api-key header. Expiry format "28-Oct-2025", strike as int,
// right = CE/PE.
// Sandbox mode: sandbox engine fallback (sim LTP), flagged.
// ============================================================

const BASE = 'https://api.icicidirect.com/breezeapi/api/v1'

const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function breezeExpiry(expiry?: string | null): string | undefined {
  if (!expiry) return undefined
  const [y, m, d] = expiry.split('-')
  return `${d}-${mons[parseInt(m) - 1]}-${y}`
}

const breezeAdapter: BrokerAdapter = {
  brokerType: 'ICICI_BREEZE',
  isLiveCapable: () => true,

  mapSymbol(master) {
    // Breeze payloads take separate fields; brokerSymbol is a readable composite
    const exp = breezeExpiry(master.expiry)
    let brokerSymbol = master.symbol
    if (master.instrumentType === 'FUT') brokerSymbol = `${master.symbol}-FUT`
    else if (master.instrumentType === 'CE' || master.instrumentType === 'PE')
      brokerSymbol = `${master.symbol}-${master.strike}-${master.optionType}`
    return { brokerSymbol, brokerToken: `${master.symbol}|${exp ?? ''}|${master.strike ?? ''}|${master.optionType ?? ''}` }
  },

  modeLabel(creds) {
    return creds?.sessionToken ? 'Live (Breeze API)' : 'Sandbox (no session token)'
  },

  async placeOrder(ctx: LegContext): Promise<OrderLegResult> {
    const units = ctx.order.qty * ctx.symbolMap.lotSize
    if (ctx.credentials?.sessionToken && ctx.credentials?.apiKey) {
      try {
        const m = ctx.symbolMap.brokerToken?.split('|') ?? []
        const body: Record<string, unknown> = {
          product: ctx.order.productType === 'CNC' ? 'delivery' : 'margin',
          action: ctx.order.side.toLowerCase(),
          price: ctx.order.limitPrice ? ctx.order.limitPrice.toFixed(2) : '0',
          validity: 'day',
          disclosure_quantity: '0',
          exchange_code: ctx.symbolMap.exchange === 'NFO' ? 'NFO' : 'NSE',
          quantity: String(units),
          order_type: ctx.order.orderType === 'LIMIT' ? 'limit' : ctx.order.orderType === 'SL' ? 'stoploss' : 'market',
          stock_code: m[0],
          remarks: (ctx.order.source + (ctx.order.strategyId ? ':' + ctx.order.strategyId : '')).slice(0, 20),
        }
        if (ctx.symbolMap.instrumentType === 'FUT') body.expiry_date = breezeExpiry(ctx.symbolMap.brokerToken?.split('|')[1])
        if (ctx.symbolMap.instrumentType === 'CE' || ctx.symbolMap.instrumentType === 'PE') {
          body.right = ctx.symbolMap.instrumentType
          body.strike_price = String(Math.round(Number(m[2])))
          body.expiry_date = breezeExpiry(m[1])
          body.product = 'options'
        }
        const res = await fetch(`${BASE}/orders`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ctx.credentials.sessionToken}`,
            'X-SessionToken': ctx.credentials.sessionToken,
            'api-key': ctx.credentials.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(4000),
        })
        const data = (await res.json()) as { Status?: number; Result?: { OrderID?: string }; Error?: string }
        if (data.Status === 1 && data.Result?.OrderID) {
          logBroker('ICICI_BREEZE', ctx.accountId, `LIVE order ${data.Result.OrderID} ${ctx.order.side} ${units} ${ctx.symbolMap.brokerSymbol}`)
          return {
            accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'ICICI_BREEZE',
            brokerOrderId: data.Result.OrderID, status: 'OPEN', qty: ctx.order.qty, message: 'Live order accepted by Breeze',
          }
        }
        logBroker('ICICI_BREEZE', ctx.accountId, `API error: ${data.Error ?? res.status}`, 'WARN')
      } catch {
        logBroker('ICICI_BREEZE', ctx.accountId, 'API unreachable — sandbox fallback', 'WARN')
      }
    }
    if (!ctx.credentials?.sessionToken) {
      rejectOrder(ctx, 'Sandbox fill (no live credentials)')
    }
    const slip = ctx.ltp * 0.0003
    const price = ctx.order.side === 'BUY' ? ctx.ltp + slip : ctx.ltp - slip
    const fill = applyFill(ctx, price)
    return {
      accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'ICICI_BREEZE',
      brokerOrderId: fill.brokerOrderId, status: 'FILLED', qty: ctx.order.qty,
      price: fill.fillPrice, message: 'SANDBOX fill (Breeze unreachable/no token)', sandbox: true,
    }
  },

  async cancelOrder(ctx, brokerOrderId) {
    if (ctx.credentials?.sessionToken) {
      try {
        const res = await fetch(`${BASE}/orders`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${ctx.credentials.sessionToken}`,
            'api-key': ctx.credentials.apiKey ?? '',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ order_id: brokerOrderId, action: 'cancel' }),
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok) return { ok: true }
      } catch { /* sandbox */ }
    }
    return { ok: true, message: 'Sandbox cancel attempted' }
  },
}

registerAdapter(breezeAdapter)
export default breezeAdapter
