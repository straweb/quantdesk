import type {
  BrokerAdapter, LegContext, OrderLegResult,
  BrokerBookRow, BrokerTradeRow, BrokerPositionRow, BrokerFundsRow, BrokerQuoteRow, ModifyPatch,
} from '../registry'
import { registerAdapter } from '../registry'
import { applyFill, rejectOrder } from '../execution'
import { logBroker } from '../database'
import { liveFetch, num, normalizeStatus } from '../live-api'

// ============================================================
// ICICI Direct Breeze broker plugin — Breeze REST API v1.
// Full live surface:
//   POST   /orders                 place
//   PUT    /orders                 modify (action: 'modify')
//   PATCH  /orders                 cancel (action: 'cancel')
//   GET    /orders                 order book (?id= for detail)
//   GET    /trades                 trade book
//   GET    /portfolio/positions    position book
//   GET    /customer/margins       funds / margin
//   GET    /quotes                 L1 quote (stock_code + right/strike/expiry)
// Auth: Authorization: Bearer <session token> + api-key header.
// Expiry format "28-Oct-2025", strike as int, right = CE/PE.
// Sandbox mode: sandbox engine fallback (sim LTP), flagged.
// ============================================================

const BASE = 'https://api.icicidirect.com/breezeapi/api/v1'

const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function breezeExpiry(expiry?: string | null): string | undefined {
  if (!expiry) return undefined
  const [y, m, d] = expiry.split('-')
  return `${d}-${mons[parseInt(m) - 1]}-${y}`
}

function breezeHeaders(creds: Record<string, string> | null): Record<string, string> {
  return {
    'Authorization': `Bearer ${creds?.sessionToken ?? ''}`,
    'X-SessionToken': creds?.sessionToken ?? '',
    'api-key': creds?.apiKey ?? '',
    'Content-Type': 'application/json',
  }
}

function toBookRow(o: Record<string, unknown>): BrokerBookRow {
  const raw = String(o.status ?? '')
  return {
    brokerOrderId: String(o.order_id ?? ''),
    symbol: String(o.stock_code ?? ''),
    side: String(o.action ?? '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
    qty: num(o.quantity) ?? 0,
    filledQty: normalizeStatus(raw) === 'FILLED' ? num(o.quantity) ?? 0 : undefined,
    status: normalizeStatus(raw),
    rawStatus: raw,
    avgPrice: num(o.average_price) ?? num(o.price) ?? undefined,
    orderType: String(o.order_type ?? ''),
    ts: String(o.order_date ?? ''),
  }
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

  sessionKind() { return 'daily' }, // Breeze sessions are refreshed daily (TOTP flow)

  async placeOrder(ctx: LegContext): Promise<OrderLegResult> {
    const units = ctx.order.qty * ctx.symbolMap.lotSize
    if (ctx.credentials?.sessionToken && ctx.credentials?.apiKey) {
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
      if (ctx.order.triggerPrice) body.trigger_price = ctx.order.triggerPrice.toFixed(2)
      if (ctx.symbolMap.instrumentType === 'FUT') body.expiry_date = breezeExpiry(ctx.symbolMap.brokerToken?.split('|')[1])
      if (ctx.symbolMap.instrumentType === 'CE' || ctx.symbolMap.instrumentType === 'PE') {
        body.right = ctx.symbolMap.instrumentType
        body.strike_price = String(Math.round(Number(m[2])))
        body.expiry_date = breezeExpiry(m[1])
        body.product = 'options'
      }
      const res = await liveFetch<{ Status?: number; Result?: { OrderID?: string }; Error?: string }>(`${BASE}/orders`, {
        method: 'POST', headers: breezeHeaders(ctx.credentials), body: JSON.stringify(body),
      })
      if (res.data?.Status === 1 && res.data.Result?.OrderID) {
        logBroker('ICICI_BREEZE', ctx.accountId, `LIVE order ${res.data.Result.OrderID} ${ctx.order.side} ${units} ${ctx.symbolMap.brokerSymbol}`)
        return {
          accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'ICICI_BREEZE',
          brokerOrderId: res.data.Result.OrderID, status: 'OPEN', qty: ctx.order.qty, message: 'Live order accepted by Breeze',
        }
      }
      logBroker('ICICI_BREEZE', ctx.accountId, `API error: ${res.data?.Error ?? res.error ?? res.status}`, 'WARN')
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

  async modifyOrder(ctx, brokerOrderId, patch: ModifyPatch) {
    if (!ctx.credentials?.sessionToken) return { ok: false, message: 'no live credentials' }
    const body: Record<string, unknown> = { order_id: brokerOrderId, action: 'modify' }
    if (patch.qty != null) body.quantity = String(patch.qty * ctx.symbolMap.lotSize)
    if (patch.limitPrice != null) body.price = patch.limitPrice.toFixed(2)
    if (patch.triggerPrice != null) body.trigger_price = patch.triggerPrice.toFixed(2)
    if (patch.orderType) body.order_type = patch.orderType === 'LIMIT' ? 'limit' : patch.orderType === 'SL' ? 'stoploss' : patch.orderType === 'SL-M' ? 'stoploss-market' : 'market'
    const res = await liveFetch<{ Status?: number; Error?: string }>(`${BASE}/orders`, {
      method: 'PUT', headers: breezeHeaders(ctx.credentials), body: JSON.stringify(body),
    })
    const ok = res.data?.Status === 1 || res.ok
    logBroker('ICICI_BREEZE', ctx.accountId, `LIVE modify ${brokerOrderId}: ${ok ? 'ok' : res.data?.Error ?? res.error}`, ok ? 'INFO' : 'WARN')
    return { ok, message: ok ? 'Live order modified' : res.data?.Error ?? res.error }
  },

  async cancelOrder(ctx, brokerOrderId) {
    if (ctx.credentials?.sessionToken) {
      const res = await liveFetch<{ Status?: number; Error?: string }>(`${BASE}/orders`, {
        method: 'PATCH',
        headers: breezeHeaders(ctx.credentials),
        body: JSON.stringify({ order_id: brokerOrderId, action: 'cancel' }),
        timeoutMs: 3000,
      })
      if (res.ok || res.data?.Status === 1) return { ok: true, message: 'Live order cancelled' }
      return { ok: false, message: res.data?.Error ?? 'cancel failed' }
    }
    return { ok: true, message: 'Sandbox cancel attempted' }
  },

  async getOrderBook(ctx) {
    if (!ctx.credentials?.sessionToken) return []
    const res = await liveFetch<{ Status?: number; Result?: Record<string, unknown>[] }>(`${BASE}/orders`, { headers: breezeHeaders(ctx.credentials) })
    const rows = res.data?.Result
    return Array.isArray(rows) ? rows.map(toBookRow) : []
  },

  async getOrderStatus(ctx, brokerOrderId) {
    if (!ctx.credentials?.sessionToken) return null
    const res = await liveFetch<{ Status?: number; Result?: Record<string, unknown> }>(
      `${BASE}/orders?id=${encodeURIComponent(brokerOrderId)}`, { headers: breezeHeaders(ctx.credentials) },
    )
    return res.data?.Result ? toBookRow(res.data.Result) : null
  },

  async getTradeBook(ctx) {
    if (!ctx.credentials?.sessionToken) return []
    const res = await liveFetch<{ Status?: number; Result?: Record<string, unknown>[] }>(`${BASE}/trades`, { headers: breezeHeaders(ctx.credentials) })
    const rows = res.data?.Result
    if (!Array.isArray(rows)) return []
    return rows.map(t => ({
      tradeId: String(t.trade_id ?? t.exchange_trade_id ?? ''),
      orderId: String(t.order_id ?? ''),
      symbol: String(t.stock_code ?? ''),
      side: String(t.action ?? '').toUpperCase(),
      qty: num(t.quantity) ?? 0,
      price: num(t.price) ?? 0,
      ts: String(t.trade_date ?? ''),
    }))
  },

  async getPositionsLive(ctx) {
    if (!ctx.credentials?.sessionToken) return []
    const res = await liveFetch<{ Status?: number; Result?: Record<string, unknown>[] }>(
      `${BASE}/portfolio/positions?exchange_code=NFO`, { headers: breezeHeaders(ctx.credentials) },
    )
    const rows = res.data?.Result
    if (!Array.isArray(rows)) return []
    return rows
      .filter(p => num(p.quantity) !== 0)
      .map(p => ({
        symbol: String(p.stock_code ?? ''),
        netQty: num(p.quantity) ?? 0,
        avgPrice: num(p.average_price ?? p.avg_price) ?? 0,
        ltp: num(p.ltp) ?? undefined,
        pnl: num(p.mark_to_market ?? p.mtm) ?? undefined,
        productType: String(p.product_type ?? ''),
      }))
  },

  async getFunds(ctx) {
    if (!ctx.credentials?.sessionToken) return { cash: 0 }
    const res = await liveFetch<{ Status?: number; Result?: Record<string, unknown> }>(`${BASE}/customer/margins`, { headers: breezeHeaders(ctx.credentials) })
    const r = res.data?.Result ?? {}
    // Breeze margin payload keys vary — probe the common ones
    const cash = num(r.margin_available) ?? num(r.net_available_cash) ?? num(r.available_cash) ?? num(r.marginavailable) ?? 0
    return { cash, utilized: num(r.margin_utilized) ?? num(r.utilized_amount) ?? 0 }
  },

  async getQuote(ctx, token) {
    if (!ctx.credentials?.sessionToken) return { symbol: token, ltp: 0 }
    // token = stock_code|expiry|strike|right (see mapSymbol)
    const [stock, expiry, strike, right] = token.split('|')
    const isOpt = !!strike && !!right
    const params = new URLSearchParams({
      stock_code: stock,
      exchange_code: ctx.symbolMap.exchange === 'NFO' ? 'NFO' : 'NSE',
      product: ctx.symbolMap.instrumentType === 'FUT' ? 'futures' : isOpt ? 'options' : 'cash',
    })
    if (expiry) params.set('expiry_date', expiry)
    if (isOpt) { params.set('right', right); params.set('strike_price', String(Math.round(Number(strike)))) }
    const res = await liveFetch<{ Status?: number; Result?: Record<string, unknown>[] }>(`${BASE}/quotes?${params}`, { headers: breezeHeaders(ctx.credentials), timeoutMs: 3000 })
    const row = Array.isArray(res.data?.Result) ? res.data.Result[0] : null
    if (!row) return { symbol: token, ltp: 0 }
    return {
      symbol: token,
      ltp: num(row.ltp) ?? 0,
      bid: num(row.buy_price ?? row.bp1),
      ask: num(row.sell_price ?? row.sp1),
      open: num(row.open), high: num(row.high), low: num(row.low), prevClose: num(row.close),
      volume: num(row.volume),
    }
  },
}

registerAdapter(breezeAdapter)
export default breezeAdapter
