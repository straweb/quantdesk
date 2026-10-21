import type { BrokerAdapter, LegContext, OrderLegResult } from '../registry'
import { registerAdapter } from '../registry'
import { applyFill, rejectOrder } from '../execution'
import { logBroker } from '../database'

// ============================================================
// Dhan broker plugin — Dhan API v2 (REST).
// Live mode: POST https://api.dhan.co/v2/orders with access-token header.
// Sandbox mode: if credentials absent or API unreachable, the leg
// executes against the sandbox engine (sim LTP) and is flagged.
// Docs: https://dhanhq.co/docs/v2/orders/
// ============================================================

const BASE = 'https://api.dhan.co/v2'

function mapTransactionType(side: 'BUY' | 'SELL') { return side } // Dhan uses BUY/SELL
function mapProduct(p: 'MIS' | 'CNC' | 'NRML') { return p === 'CNC' ? 'CNC' : p === 'MIS' ? 'INTRADAY' : 'MARGIN' }
function mapOrderType(t: string) { return t === 'MARKET' ? 'MARKET' : t === 'LIMIT' ? 'LIMIT' : t === 'SL' ? 'STOP_LOSS' : 'STOP_LOSS_MARKET' }

function livePayload(ctx: LegContext) {
  const units = ctx.order.qty * ctx.symbolMap.lotSize
  return {
    dhanClientId: ctx.credentials?.clientId ?? '',
    transactionType: mapTransactionType(ctx.order.side),
    exchangeSegment: ctx.symbolMap.exchange === 'NFO' ? 'NSE_FNO' : ctx.symbolMap.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ',
    productType: mapProduct(ctx.order.productType),
    orderType: mapOrderType(ctx.order.orderType),
    validity: 'DAY',
    securityId: ctx.symbolMap.brokerToken,
    quantity: units,
    price: ctx.order.limitPrice ? Number(ctx.order.limitPrice.toFixed(2)) : 0,
    triggerPrice: ctx.order.triggerPrice ? Number(ctx.order.triggerPrice.toFixed(2)) : 0,
    disclosed_quantity: 0,
    afterMarketOrder: false,
    tag: (ctx.order.source + (ctx.order.strategyId ? ':' + ctx.order.strategyId : '')).slice(0, 20),
  }
}

const dhanAdapter: BrokerAdapter = {
  brokerType: 'DHAN',
  isLiveCapable: () => true,

  mapSymbol(master) {
    // Dhan uses numeric securityIds; deterministic sandbox tokens, real tokens
    // come from the daily master contract CSV in live deployments.
    let hash = 0
    const key = `${master.symbol}|${master.instrumentType}|${master.expiry ?? ''}|${master.strike ?? ''}`
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 1
    const token = String(10000 + (hash % 89999))
    let brokerSymbol = master.symbol
    if (master.instrumentType === 'FUT') brokerSymbol = `${master.symbol}-${master.expiry}-FUT`
    else if (master.instrumentType === 'CE' || master.instrumentType === 'PE') brokerSymbol = `${master.symbol}-${master.strike}-${master.optionType}-${master.expiry}`
    return { brokerSymbol, brokerToken: token }
  },

  modeLabel(creds) {
    return creds?.accessToken ? 'Live (Dhan API v2)' : 'Sandbox (no access token)'
  },

  async placeOrder(ctx: LegContext): Promise<OrderLegResult> {
    const units = ctx.order.qty * ctx.symbolMap.lotSize
    if (ctx.credentials?.accessToken) {
      try {
        const res = await fetch(`${BASE}/orders`, {
          method: 'POST',
          headers: {
            'access-token': ctx.credentials.accessToken,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(livePayload(ctx)),
          signal: AbortSignal.timeout(4000),
        })
        const data = (await res.json()) as { orderId?: string; remarks?: string; errorMessage?: string }
        if (res.ok && data.orderId) {
          logBroker('DHAN', ctx.accountId, `LIVE order ${data.orderId} ${ctx.order.side} ${units} ${ctx.symbolMap.brokerSymbol}`)
          return {
            accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'DHAN',
            brokerOrderId: data.orderId, status: 'OPEN', qty: ctx.order.qty, message: 'Live order accepted by Dhan',
          }
        }
        logBroker('DHAN', ctx.accountId, `API error: ${data.errorMessage ?? res.status}`, 'WARN')
        // fall through to sandbox
      } catch {
        logBroker('DHAN', ctx.accountId, 'API unreachable — sandbox fallback', 'WARN')
      }
    }
    // sandbox execution
    if (!ctx.credentials?.accessToken) {
      rejectOrder(ctx, 'Sandbox fill (no live credentials)') // audit trail only
    }
    const slip = ctx.ltp * 0.0003
    const price = ctx.order.side === 'BUY' ? ctx.ltp + slip : ctx.ltp - slip
    const fill = applyFill(ctx, price)
    return {
      accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'DHAN',
      brokerOrderId: fill.brokerOrderId, status: 'FILLED', qty: ctx.order.qty,
      price: fill.fillPrice, message: 'SANDBOX fill (Dhan unreachable/no token)', sandbox: true,
    }
  },

  async cancelOrder(ctx, brokerOrderId) {
    if (ctx.credentials?.accessToken) {
      try {
        const res = await fetch(`${BASE}/orders/${brokerOrderId}`, {
          method: 'DELETE',
          headers: { 'access-token': ctx.credentials.accessToken },
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok) return { ok: true }
      } catch { /* sandbox fallback */ }
    }
    return { ok: true, message: 'Sandbox cancel attempted' }
  },
}

registerAdapter(dhanAdapter)
export default dhanAdapter
