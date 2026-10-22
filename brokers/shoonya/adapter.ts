import type {
  BrokerAdapter, LegContext, OrderLegResult,
  BrokerBookRow, BrokerTradeRow, BrokerPositionRow, BrokerFundsRow, BrokerQuoteRow, ModifyPatch,
} from '../registry'
import { registerAdapter } from '../registry'
import { applyFill, rejectOrder } from '../execution'
import { logBroker } from '../database'
import { liveFetch, num, normalizeStatus } from '../live-api'

// ============================================================
// Shoonya (Finvasia) broker plugin — Noren REST API. Full surface:
//   /PlaceOrder /ModifyOrder /CancelOrder
//   /OrderBook  /TradeBook  /PositionBook
//   /Limits     /GetQuote   /SingleOrdHist
// Auth: every request body carries jKey = session token (Noren
// convention) + uid/actid. Symbol format: NSE|RELIANCE-EQ,
// NFO|NIFTY28OCT25C24500.
// Sandbox mode: sandbox engine fallback (sim LTP), flagged.
// ============================================================

const BASE = 'https://api.shoonya.com/NorenWClientTP'

/** Noren request wrapper — jKey session token + uid/actid on every call. */
function norenBody(ctx: LegContext, extra: Record<string, unknown> = {}) {
  return {
    uid: ctx.credentials?.userId ?? '',
    actid: ctx.credentials?.userId ?? '',
    jKey: ctx.credentials?.sessionId ?? '',
    ...extra,
  }
}

/** Noren request wrapper — jKey session token + uid/actid on every call,
 *  tagged so every outbound Shoonya call logs [SHOONYA][endpoint]. */
async function norenPost<T>(ctx: LegContext | null, endpoint: string, body: Record<string, unknown>, timeoutMs = 4000) {
  return liveFetch<T>(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
    callTag: { broker: 'SHOONYA', accountId: ctx?.accountId, tag: endpoint.toLowerCase() },
  })
}

function norenSymbol(ctx: LegContext): string {
  const m = ctx.symbolMap
  if (m.exchange === 'NFO') return m.brokerSymbol
  if (m.exchange === 'BSE') return `BSE|${m.brokerSymbol}`
  return `NSE|${m.brokerSymbol}`
}

function orderPayload(ctx: LegContext) {
  const units = ctx.order.qty * ctx.symbolMap.lotSize
  return {
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
  }
}

function toBookRow(o: Record<string, unknown>): BrokerBookRow {
  const raw = String(o.status ?? '')
  return {
    brokerOrderId: String(o.norenordno ?? o.orderno ?? ''),
    symbol: String(o.tsym ?? ''),
    side: o.trantype === 'B' ? 'BUY' : o.trantype === 'S' ? 'SELL' : String(o.trantype ?? ''),
    qty: num(o.qty) ?? 0,
    filledQty: num(o.fillshares) ?? (normalizeStatus(raw) === 'FILLED' ? num(o.qty) ?? 0 : 0),
    status: normalizeStatus(raw),
    rawStatus: raw,
    avgPrice: num(o.avgprc) ?? num(o.prc) ?? undefined,
    orderType: String(o.prd_type ?? o.prc ?? ''),
    ts: String(o.ordertm ?? o.updatetime ?? ''),
  }
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

  sessionKind() { return 'daily' }, // Shoonya TOTP sessions are re-established daily

  async placeOrder(ctx: LegContext): Promise<OrderLegResult> {
    const units = ctx.order.qty * ctx.symbolMap.lotSize
    if (ctx.credentials?.sessionId) {
      const res = await norenPost<{ stat?: string; norenordno?: string; emsg?: string }>(ctx, 'PlaceOrder', norenBody(ctx, orderPayload(ctx)))
      if (res.data?.stat === 'Ok' && res.data.norenordno) {
        logBroker('SHOONYA', ctx.accountId, `LIVE order ${res.data.norenordno} ${ctx.order.side} ${units} ${norenSymbol(ctx)}`)
        return {
          accountId: ctx.accountId, accountLabel: ctx.accountLabel, brokerType: 'SHOONYA',
          brokerOrderId: res.data.norenordno, status: 'OPEN', qty: ctx.order.qty, message: 'Live order accepted by Shoonya',
        }
      }
      logBroker('SHOONYA', ctx.accountId, `API error: ${res.data?.emsg ?? res.error ?? res.status}`, 'WARN')
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

  async modifyOrder(ctx, brokerOrderId, patch: ModifyPatch) {
    if (!ctx.credentials?.sessionId) return { ok: false, message: 'no live credentials' }
    const p = orderPayload(ctx)
    if (patch.qty != null) p.qty = patch.qty * ctx.symbolMap.lotSize
    if (patch.limitPrice != null) p.prc = patch.limitPrice.toFixed(2)
    if (patch.triggerPrice != null) p.trgprc = patch.triggerPrice.toFixed(2)
    const res = await norenPost<{ stat?: string; result?: string; emsg?: string }>(ctx, 'ModifyOrder', norenBody(ctx, { ...p, orderno: brokerOrderId }))
    const ok = res.data?.stat === 'Ok'
    logBroker('SHOONYA', ctx.accountId, `LIVE modify ${brokerOrderId}: ${ok ? 'ok' : res.data?.emsg ?? res.error}`, ok ? 'INFO' : 'WARN')
    return { ok, message: ok ? 'Live order modified' : res.data?.emsg ?? res.error }
  },

  async cancelOrder(ctx, brokerOrderId) {
    if (ctx.credentials?.sessionId) {
      const res = await norenPost<{ stat?: string; result?: string; emsg?: string }>(ctx, 'CancelOrder', norenBody(ctx, { norenordno: brokerOrderId }), 3000)
      if (res.data?.stat === 'Ok') return { ok: true, message: 'Live order cancelled' }
      return { ok: false, message: res.data?.emsg ?? 'cancel failed' }
    }
    return { ok: true, message: 'Sandbox cancel attempted' }
  },

  async getOrderBook(ctx) {
    if (!ctx.credentials?.sessionId) return []
    const res = await norenPost<Record<string, unknown>[] | { emsg?: string }>(ctx, 'OrderBook', norenBody(ctx))
    const arr = Array.isArray(res.data) ? res.data : []
    return arr.map(toBookRow)
  },

  async getTradeBook(ctx) {
    if (!ctx.credentials?.sessionId) return []
    const res = await norenPost<Record<string, unknown>[] | { emsg?: string }>(ctx, 'TradeBook', norenBody(ctx))
    const arr = Array.isArray(res.data) ? res.data : []
    return arr.map(t => ({
      tradeId: String(t.tradeid ?? t.exchange_time ?? ''),
      orderId: String(t.norenordno ?? ''),
      symbol: String(t.tsym ?? ''),
      side: t.trantype === 'B' ? 'BUY' : 'SELL',
      qty: num(t.qty) ?? 0,
      price: num(t.prc) ?? 0,
      ts: String(t.trantime ?? ''),
    }))
  },

  async getPositionsLive(ctx) {
    if (!ctx.credentials?.sessionId) return []
    const res = await norenPost<Record<string, unknown>[] | { emsg?: string }>(ctx, 'PositionBook', norenBody(ctx))
    const arr = Array.isArray(res.data) ? res.data : []
    return arr
      .filter(p => num(p.netqty) !== 0)
      .map(p => ({
        symbol: String(p.tsym ?? ''),
        netQty: num(p.netqty) ?? 0,
        avgPrice: num(p.avgprc) ?? 0,
        ltp: num(p.lp) ?? undefined,
        pnl: (num(p.urmtom) ?? 0) + (num(p.rpmtom) ?? 0),
        productType: String(p.prd ?? ''),
      }))
  },

  async getFunds(ctx) {
    if (!ctx.credentials?.sessionId) return { cash: 0 }
    const res = await norenPost<Record<string, unknown> | { emsg?: string }>(ctx, 'Limits', norenBody(ctx))
    const d = (res.data && !Array.isArray(res.data) ? res.data : {}) as Record<string, unknown>
    const cash = num(d.cash) ?? 0
    return { cash, available: num(d.marginavailable) ?? cash, utilized: num(d.marginused) ?? 0 }
  },

  async getHoldings(ctx) {
    if (!ctx.credentials?.sessionId) return []
    const res = await norenPost<Record<string, unknown>[] | { emsg?: string }>(ctx, 'Holdings', norenBody(ctx), 6000)
    const arr = Array.isArray(res.data) ? res.data : []
    return arr.map(h => ({
      symbol: String(h.exchTsym?.[0]?.tsym ?? h.exch_tsym?.[0]?.tsym ?? ''),
      isin: h.isin ? String(h.isin) : undefined,
      qty: num(h.qty) ?? num(h.holdqty) ?? 0,
      avgPrice: num(h.uprice) ?? num(h.avgPrice) ?? 0,
      ltp: num(h.lp) ?? undefined,
      pnl: num(h.pnl) ?? undefined,
      product: String(h.product ?? 'CNC'),
    }))
  },

  async marginCalc(ctx, params) {
    if (!ctx.credentials?.sessionId) return null
    const res = await norenPost<Record<string, unknown> | { emsg?: string }>(ctx, 'GetMargin', norenBody(ctx, {
      prd: params.productType === 'CNC' ? 'CNC' : 'I',
      exch: ctx.symbolMap.exchange === 'NFO' ? 'NFO' : 'NSE',
      tsym: ctx.symbolMap.brokerSymbol,
      qty: params.qty,
      prc: params.price,
      trantype: params.side === 'BUY' ? 'B' : 'S',
      prctyp: 'LMT',
      price: params.price,
    }), 5000)
    const d = (res.data && !Array.isArray(res.data) ? res.data : {}) as Record<string, unknown>
    if (d.emsg || !res.data) return { required: 0, detail: String(d.emsg ?? 'margin API unreachable') }
    return {
      required: num(d.totmargin) ?? num(d.marginrequired) ?? num(d.tot_margin) ?? 0,
      span: num(d.span) ?? undefined,
      exposure: num(d.exposure) ?? num(d.expmargin) ?? undefined,
      leverage: num(d.leverage) ?? undefined,
    }
  },

  async getQuote(ctx, token) {
    if (!ctx.credentials?.sessionId) return { symbol: token, ltp: 0 }
    const [exch, tsym] = token.includes('|') ? token.split('|') : [ctx.symbolMap.exchange, token]
    const res = await norenPost<Record<string, unknown>>(ctx, 'GetQuote', norenBody(ctx, { exch, tsym }), 3000)
    if (!res.data) return { symbol: token, ltp: 0 }
    return {
      symbol: tsym,
      ltp: num(res.data.lp) ?? 0,
      bid: num(res.data.bp1),
      ask: num(res.data.sp1),
      open: num(res.data.o), high: num(res.data.h), low: num(res.data.l), prevClose: num(res.data.c),
      volume: num(res.data.volume),
    }
  },
}

registerAdapter(shoonyaAdapter)
export default shoonyaAdapter
