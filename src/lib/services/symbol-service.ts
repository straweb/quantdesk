import { db } from '../db'
import { adapters } from '../../../brokers/index'
import { BROKER_TYPES } from '../types'
import type { BrokerType } from '../types'

// ============================================================
// Master contracts (symbols) service.
// - Generates/refreshes the canonical SymbolMaster universe
//   (in production these are the daily NSE/BSE contract files
//   downloaded from the exchange; here a deterministic seeded
//   generator produces the same shape).
// - Maps every master symbol to each broker's own symbol/token
//   via the broker adapters -> SymbolMapping (copy trading ready).
// - Publishes the universe to the market feed mini-service.
// ============================================================

const FEED_URL = process.env.FEED_SERVICE_URL || 'http://localhost:3004'

export const INDEX_UNIVERSE: { symbol: string; name: string; base: number }[] = [
  { symbol: 'NIFTY', name: 'Nifty 50 Index', base: 24500 },
  { symbol: 'BANKNIFTY', name: 'Nifty Bank Index', base: 51800 },
  { symbol: 'FINNIFTY', name: 'Nifty Financial Services', base: 23100 },
  { symbol: 'MIDCPNIFTY', name: 'Nifty Midcap Select', base: 12250 },
  { symbol: 'SENSEX', name: 'BSE Sensex', base: 81000 },
]

/** Index constituent weights (%) used by the watchlist Index tab —
 *  contribution pts ≈ stock change pts × weight/100. Only symbols that
 *  exist in the EQ_UNIVERSE are listed (the rest of the real index weight
 *  sits in names we don't simulate). */
export const INDEX_CONSTITUENTS: Record<string, { symbol: string; weight: number }[]> = {
  NIFTY: [
    { symbol: 'RELIANCE', weight: 9.5 }, { symbol: 'HDFCBANK', weight: 8.6 },
    { symbol: 'ICICIBANK', weight: 7.4 }, { symbol: 'INFY', weight: 5.9 },
    { symbol: 'TCS', weight: 4.6 }, { symbol: 'ITC', weight: 4.4 },
    { symbol: 'LT', weight: 4.0 }, { symbol: 'KOTAKBANK', weight: 3.4 },
    { symbol: 'BHARTIARTL', weight: 3.4 }, { symbol: 'SBIN', weight: 3.1 },
    { symbol: 'AXISBANK', weight: 2.9 }, { symbol: 'M&M', weight: 2.6 },
    { symbol: 'MARUTI', weight: 2.4 }, { symbol: 'SUNPHARMA', weight: 2.0 },
    { symbol: 'TATAMOTORS', weight: 1.9 }, { symbol: 'NTPC', weight: 1.7 },
    { symbol: 'POWERGRID', weight: 1.6 }, { symbol: 'HINDUNILVR', weight: 1.6 },
    { symbol: 'ULTRACEMCO', weight: 1.5 }, { symbol: 'BAJFINANCE', weight: 1.5 },
    { symbol: 'ASIANPAINT', weight: 1.1 }, { symbol: 'TITAN', weight: 1.1 },
    { symbol: 'WIPRO', weight: 1.0 }, { symbol: 'HCLTECH', weight: 1.0 },
    { symbol: 'TECHM', weight: 1.0 }, { symbol: 'TATASTEEL', weight: 0.9 },
    { symbol: 'JSWSTEEL', weight: 0.9 }, { symbol: 'COALINDIA', weight: 0.8 },
    { symbol: 'ADANIENT', weight: 0.8 }, { symbol: 'ONGC', weight: 0.8 },
  ],
  BANKNIFTY: [
    { symbol: 'HDFCBANK', weight: 27.1 }, { symbol: 'ICICIBANK', weight: 23.3 },
    { symbol: 'SBIN', weight: 10.2 }, { symbol: 'KOTAKBANK', weight: 9.4 },
    { symbol: 'AXISBANK', weight: 8.4 }, { symbol: 'INDUSINDBK', weight: 5.0 },
  ],
  FINNIFTY: [
    { symbol: 'HDFCBANK', weight: 24.9 }, { symbol: 'ICICIBANK', weight: 20.4 },
    { symbol: 'KOTAKBANK', weight: 9.6 }, { symbol: 'AXISBANK', weight: 7.7 },
    { symbol: 'BAJFINANCE', weight: 7.6 }, { symbol: 'SBIN', weight: 6.2 },
  ],
  MIDCPNIFTY: [
    { symbol: 'TATASTEEL', weight: 6.4 }, { symbol: 'JSWSTEEL', weight: 5.9 },
    { symbol: 'COALINDIA', weight: 5.1 }, { symbol: 'ASIANPAINT', weight: 4.7 },
    { symbol: 'TITAN', weight: 4.4 }, { symbol: 'MARUTI', weight: 4.2 },
  ],
  SENSEX: [
    { symbol: 'RELIANCE', weight: 9.9 }, { symbol: 'HDFCBANK', weight: 9.3 },
    { symbol: 'ICICIBANK', weight: 8.2 }, { symbol: 'INFY', weight: 6.1 },
    { symbol: 'TCS', weight: 4.5 }, { symbol: 'BHARTIARTL', weight: 4.1 },
    { symbol: 'ITC', weight: 3.9 }, { symbol: 'LT', weight: 3.6 },
    { symbol: 'KOTAKBANK', weight: 3.1 }, { symbol: 'SBIN', weight: 3.0 },
    { symbol: 'AXISBANK', weight: 2.8 }, { symbol: 'M&M', weight: 2.7 },
    { symbol: 'MARUTI', weight: 2.6 }, { symbol: 'SUNPHARMA', weight: 2.1 },
    { symbol: 'TATAMOTORS', weight: 1.9 }, { symbol: 'NTPC', weight: 1.8 },
    { symbol: 'HINDUNILVR', weight: 1.7 }, { symbol: 'POWERGRID', weight: 1.6 },
    { symbol: 'ULTRACEMCO', weight: 1.6 }, { symbol: 'BAJFINANCE', weight: 1.5 },
    { symbol: 'ASIANPAINT', weight: 1.1 }, { symbol: 'TITAN', weight: 1.1 },
    { symbol: 'WIPRO', weight: 1.0 }, { symbol: 'HCLTECH', weight: 1.0 },
    { symbol: 'TECHM', weight: 1.0 }, { symbol: 'TATASTEEL', weight: 0.9 },
    { symbol: 'JSWSTEEL', weight: 0.9 }, { symbol: 'COALINDIA', weight: 0.8 },
    { symbol: 'ADANIENT', weight: 0.8 }, { symbol: 'ONGC', weight: 0.8 },
  ],
}

export const EQ_UNIVERSE: { symbol: string; name: string; base: number; lot: number }[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries Ltd', base: 2870, lot: 250 },
  { symbol: 'TCS', name: 'Tata Consultancy Services Ltd', base: 4150, lot: 175 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', base: 1740, lot: 550 },
  { symbol: 'INFY', name: 'Infosys Ltd', base: 1870, lot: 400 },
  { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', base: 1265, lot: 700 },
  { symbol: 'SBIN', name: 'State Bank of India', base: 830, lot: 750 },
  { symbol: 'AXISBANK', name: 'Axis Bank Ltd', base: 1170, lot: 625 },
  { symbol: 'LT', name: 'Larsen & Toubro Ltd', base: 3620, lot: 150 },
  { symbol: 'ITC', name: 'ITC Ltd', base: 465, lot: 1600 },
  { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd', base: 990, lot: 800 },
  { symbol: 'TATASTEEL', name: 'Tata Steel Ltd', base: 155, lot: 5500 },
  { symbol: 'WIPRO', name: 'Wipro Ltd', base: 545, lot: 1500 },
  { symbol: 'HCLTECH', name: 'HCL Technologies Ltd', base: 1790, lot: 350 },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance Ltd', base: 7150, lot: 75 },
  { symbol: 'MARUTI', name: 'Maruti Suzuki India Ltd', base: 12800, lot: 50 },
  { symbol: 'TITAN', name: 'Titan Company Ltd', base: 3480, lot: 175 },
  { symbol: 'ASIANPAINT', name: 'Asian Paints Ltd', base: 2950, lot: 200 },
  { symbol: 'SUNPHARMA', name: 'Sun Pharmaceutical Industries Ltd', base: 1780, lot: 350 },
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement Ltd', base: 11200, lot: 50 },
  { symbol: 'ADANIENT', name: 'Adani Enterprises Ltd', base: 3100, lot: 300 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd', base: 1580, lot: 475 },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever Ltd', base: 2520, lot: 300 },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank Ltd', base: 1780, lot: 400 },
  { symbol: 'M&M', name: 'Mahindra & Mahindra Ltd', base: 2980, lot: 200 },
  { symbol: 'POWERGRID', name: 'Power Grid Corporation', base: 345, lot: 1800 },
  { symbol: 'NTPC', name: 'NTPC Ltd', base: 375, lot: 1500 },
  { symbol: 'ONGC', name: 'Oil & Natural Gas Corp Ltd', base: 285, lot: 2250 },
  { symbol: 'JSWSTEEL', name: 'JSW Steel Ltd', base: 985, lot: 675 },
  { symbol: 'COALINDIA', name: 'Coal India Ltd', base: 495, lot: 1350 },
  { symbol: 'TECHM', name: 'Tech Mahindra Ltd', base: 1680, lot: 600 },
]

function nextExpiries(count: number, weekday = 4): string[] {
  // weekday: 4 = Thursday (ISO). Returns next `count` Thursday dates YYYY-MM-DD
  const out: string[] = []
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  while (out.length < count) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() === weekday) {
      out.push(d.toISOString().slice(0, 10))
    }
  }
  return out
}

function nextMonthEnds(count: number, weekday = 4): string[] {
  // last `weekday` of the next `count` months (for monthly futures/options)
  const out: string[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i + 1, 0) // last day of month
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

export function optionPremium(base: number, strike: number, type: 'CE' | 'PE', days: number): number {
  const intrinsic = type === 'CE' ? Math.max(0, base - strike) : Math.max(0, strike - base)
  const moneyness = Math.abs(base - strike) / base
  const tv = base * 0.006 * Math.sqrt(Math.max(1, days) / 14) * Math.exp(-moneyness * 18)
  return Math.max(intrinsic + tv, 0.05)
}

// NSE-style strike step by underlying price level
export function strikeStepFor(price: number): number {
  if (price < 200) return 5
  if (price < 500) return 10
  if (price < 1000) return 20
  if (price < 2500) return 50
  return 100
}

/** calendar date in IST — the exchange timezone the expiry dates belong to */
export function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
}

export interface SyncResult {
  symbolCount: number
  mappedCount: number
  version: string
}

export async function syncMasterContracts(source: 'SEED' | 'DAILY_SYNC' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const version = new Date().toISOString().slice(0, 10)
  // Exchange calendars (verified against the live Dhan/Noren scrip masters,
  // 2026): NSE F&O weeklies/monthlies expire on TUESDAY, BSE (SENSEX/BANKEX)
  // on THURSDAY. Keeping these aligned makes the scrip-master token
  // enrichment (Dhan securityId / Noren tsym) match 1:1.
  const weekly = nextExpiries(2, 2) // NFO weekly option expiries (Tue)
  const weeklyBse = nextExpiries(2, 4) // BFO weekly expiries (Thu)
  const monthly = nextMonthEnds(2, 2) // NFO monthly (Tue)
  const daysTo = (exp: string) => Math.max(0, Math.round((new Date(exp).getTime() - Date.now()) / 86400000))

  interface Row {
    symbol: string; name: string; exchange: string; instrumentType: string
    expiry?: string; strike?: number; optionType?: string; lotSize: number
    tickSize: number; underlying?: string; basePrice?: number
  }
  const rows: Row[] = []

  // --- Indices ---
  for (const i of INDEX_UNIVERSE) {
    rows.push({ symbol: i.symbol, name: i.name, exchange: 'NSE', instrumentType: 'INDEX', lotSize: 1, tickSize: 0.05, basePrice: i.base })
  }
  // --- Equities ---
  for (const e of EQ_UNIVERSE) {
    rows.push({ symbol: e.symbol, name: e.name, exchange: 'NSE', instrumentType: 'EQ', lotSize: e.lot, tickSize: 0.05, basePrice: e.base })
  }
  // --- Index futures (weekly[0] + monthly) ---
  const futExpiries = [...new Set([weekly[0], ...monthly])]
  for (const idx of INDEX_UNIVERSE.slice(0, 2)) {
    for (const exp of futExpiries) {
      rows.push({ symbol: `${idx.symbol}${exp.replaceAll('-', '')}FUT`, name: `${idx.symbol} ${exp} Fut`, exchange: 'NFO', instrumentType: 'FUT', expiry: exp, lotSize: idx.symbol === 'NIFTY' ? 75 : 30, tickSize: 0.05, underlying: idx.symbol, basePrice: idx.base })
    }
  }
  // --- Stock futures (monthly[0]) ---
  for (const e of EQ_UNIVERSE.slice(0, 10)) {
    rows.push({ symbol: `${e.symbol}${monthly[0].replaceAll('-', '')}FUT`, name: `${e.symbol} ${monthly[0]} Fut`, exchange: 'NFO', instrumentType: 'FUT', expiry: monthly[0], lotSize: e.lot, tickSize: 0.05, underlying: e.symbol, basePrice: e.base })
  }
  // --- NIFTY weekly options: 2 expiries, ATM ±10 steps of 50 ---
  for (const exp of weekly) {
    const base = INDEX_UNIVERSE[0].base
    const atm = Math.round(base / 50) * 50
    for (let k = -10; k <= 10; k++) {
      const strike = atm + k * 50
      for (const t of ['CE', 'PE'] as const) {
        rows.push({
          symbol: `NIFTY${exp.replaceAll('-', '')}${strike}${t}`,
          name: `Nifty ${strike} ${t} ${exp}`,
          exchange: 'NFO', instrumentType: t, expiry: exp, strike, optionType: t,
          lotSize: 75, tickSize: 0.05, underlying: 'NIFTY',
          basePrice: optionPremium(base, strike, t, daysTo(exp)),
        })
      }
    }
  }
  // --- BANKNIFTY monthly options: ATM ±2000 step 100 ---
  {
    const exp = monthly[0]
    const base = INDEX_UNIVERSE[1].base
    const atm = Math.round(base / 100) * 100
    for (let k = -20; k <= 20; k++) {
      const strike = atm + k * 100
      for (const t of ['CE', 'PE'] as const) {
        rows.push({
          symbol: `BANKNIFTY${exp.replaceAll('-', '')}${strike}${t}`,
          name: `Bank Nifty ${strike} ${t} ${exp}`,
          exchange: 'NFO', instrumentType: t, expiry: exp, strike, optionType: t,
          lotSize: 30, tickSize: 0.05, underlying: 'BANKNIFTY',
          basePrice: optionPremium(base, strike, t, daysTo(exp)),
        })
      }
    }
  }
  // --- Stock options (F&O equities): monthly expiry, ATM ±10, price-based step ---
  for (const e of EQ_UNIVERSE.slice(0, 10)) {
    const exp = monthly[0]
    const step = strikeStepFor(e.base)
    const atm = Math.round(e.base / step) * step
    for (let k = -10; k <= 10; k++) {
      const strike = Number((atm + k * step).toFixed(2))
      for (const t of ['CE', 'PE'] as const) {
        rows.push({
          symbol: `${e.symbol}${exp.replaceAll('-', '')}${strike}${t}`,
          name: `${e.symbol} ${strike} ${t} ${exp}`,
          exchange: 'NFO', instrumentType: t, expiry: exp, strike, optionType: t,
          lotSize: e.lot, tickSize: 0.05, underlying: e.symbol,
          basePrice: optionPremium(e.base, strike, t, daysTo(exp)),
        })
      }
    }
  }

  // --- BFO (BSE F&O): BANKEX futures + weekly options (SENSEX lives on NSE rows here) ---
  {
    const base = 58000
    const lot = 15
    rows.push({ symbol: 'BANKEX', name: 'BSE Bankex Index', exchange: 'BSE', instrumentType: 'INDEX', lotSize: 1, tickSize: 0.05, basePrice: base })
    for (const exp of weeklyBse) {
      rows.push({ symbol: `BANKEX${exp.replaceAll('-', '')}FUT`, name: `BANKEX ${exp} Fut`, exchange: 'BFO', instrumentType: 'FUT', expiry: exp, lotSize: lot, tickSize: 0.05, underlying: 'BANKEX', basePrice: base })
      const atm = Math.round(base / 100) * 100
      for (let k = -6; k <= 6; k++) {
        const strike = atm + k * 100
        for (const t of ['CE', 'PE'] as const) {
          rows.push({
            symbol: `BANKEX${exp.replaceAll('-', '')}${strike}${t}`,
            name: `BANKEX ${strike} ${t} ${exp}`,
            exchange: 'BFO', instrumentType: t, expiry: exp, strike, optionType: t,
            lotSize: lot, tickSize: 0.05, underlying: 'BANKEX',
            basePrice: optionPremium(base, strike, t, daysTo(exp)),
          })
        }
      }
    }
  }

  // --- MCX commodities: base + monthly futures + ATM±4 options ---
  const COMM_UNIVERSE = [
    { symbol: 'GOLD', name: 'Gold', base: 76500, lot: 100, step: 100 },
    { symbol: 'SILVER', name: 'Silver', base: 91000, lot: 30, step: 500 },
    { symbol: 'CRUDEOIL', name: 'Crude Oil', base: 6150, lot: 100, step: 50 },
    { symbol: 'NATURALGAS', name: 'Natural Gas', base: 245, lot: 1250, step: 5 },
    { symbol: 'COPPER', name: 'Copper', base: 852, lot: 2500, step: 5 },
    { symbol: 'ZINC', name: 'Zinc', base: 278, lot: 5000, step: 5 },
    { symbol: 'ALUMINIUM', name: 'Aluminium', base: 248, lot: 5000, step: 5 },
  ]
  for (const c of COMM_UNIVERSE) {
    rows.push({ symbol: c.symbol, name: c.name, exchange: 'MCX', instrumentType: 'COMM', lotSize: c.lot, tickSize: 0.05, basePrice: c.base })
    for (const exp of monthly) {
      rows.push({ symbol: `${c.symbol}${exp.replaceAll('-', '')}FUT`, name: `${c.name} ${exp} Fut`, exchange: 'MCX', instrumentType: 'FUT', expiry: exp, lotSize: c.lot, tickSize: 0.05, underlying: c.symbol, basePrice: c.base })
    }
    const exp = monthly[0]
    const atm = Math.round(c.base / c.step) * c.step
    for (let k = -4; k <= 4; k++) {
      const strike = atm + k * c.step
      for (const t of ['CE', 'PE'] as const) {
        rows.push({
          symbol: `${c.symbol}${exp.replaceAll('-', '')}${strike}${t}`,
          name: `${c.name} ${strike} ${t} ${exp}`,
          exchange: 'MCX', instrumentType: t, expiry: exp, strike, optionType: t,
          lotSize: c.lot, tickSize: 0.05, underlying: c.symbol,
          basePrice: optionPremium(c.base, strike, t, daysTo(exp)),
        })
      }
    }
  }

  // --- CDS currency derivatives: base + monthly futures ---
  const CUR_UNIVERSE = [
    { symbol: 'USDINR', name: 'US Dollar INR', base: 84.35, lot: 1000 },
    { symbol: 'EURINR', name: 'Euro INR', base: 91.2, lot: 1000 },
    { symbol: 'GBPINR', name: 'Pound INR', base: 108.4, lot: 1000 },
    { symbol: 'JPYINR', name: 'Yen INR', base: 56.2, lot: 1000 },
  ]
  for (const c of CUR_UNIVERSE) {
    rows.push({ symbol: c.symbol, name: c.name, exchange: 'CDS', instrumentType: 'CUR', lotSize: c.lot, tickSize: 0.0025, basePrice: c.base })
    for (const exp of monthly) {
      rows.push({ symbol: `${c.symbol}${exp.replaceAll('-', '')}FUT`, name: `${c.name} ${exp} Fut`, exchange: 'CDS', instrumentType: 'FUT', expiry: exp, lotSize: c.lot, tickSize: 0.0025, underlying: c.symbol, basePrice: c.base })
    }
  }

  // --- upsert master symbols ---
  let symbolCount = 0
  for (const r of rows) {
    await db.symbolMaster.upsert({
      where: { symbol_exchange: { symbol: r.symbol, exchange: r.exchange } },
      create: {
        symbol: r.symbol, name: r.name, exchange: r.exchange, instrumentType: r.instrumentType,
        expiry: r.expiry, strike: r.strike, optionType: r.optionType,
        lotSize: r.lotSize, tickSize: r.tickSize, underlying: r.underlying,
        basePrice: r.basePrice, version,
      },
      update: {
        name: r.name, lotSize: r.lotSize, basePrice: r.basePrice,
        expiry: r.expiry, strike: r.strike, version,
      },
    })
    symbolCount++
  }

  // --- broker mappings ---
  const masterRows = await db.symbolMaster.findMany({ where: { version } })
  let mappedCount = 0
  for (const m of masterRows) {
    for (const bt of BROKER_TYPES as BrokerType[]) {
      const adapter = adapters[bt]
      if (!adapter) continue
      const gen = adapter.mapSymbol({
        symbol: m.symbol, exchange: m.exchange, instrumentType: m.instrumentType,
        expiry: m.expiry, strike: m.strike, optionType: m.optionType,
      })
      await db.symbolMapping.upsert({
        where: { masterId_brokerType: { masterId: m.id, brokerType: bt } },
        create: { masterId: m.id, brokerType: bt, brokerSymbol: gen.brokerSymbol, brokerToken: gen.brokerToken },
        update: { brokerSymbol: gen.brokerSymbol, brokerToken: gen.brokerToken },
      })
      mappedCount++
    }
  }

  // --- publish universe to feed service ---
  // Publish every LIVE master row (no expiry, or expiry >= IST today) —
  // not just today's version — so the chain/ATM series selected by
  // getChainMeta always has feed prices (stale-expired rows stay out).
  try {
    const liveRows = await db.symbolMaster.findMany({
      where: { OR: [{ expiry: null }, { expiry: { gte: istToday() } }] },
      orderBy: { id: 'asc' },
    })
    await publishUniverseToFeed(liveRows)
  } catch { /* fall back to the version rows below */ }
  await publishUniverseToFeed(masterRows)

  // --- enrich DHAN/SHOONYA mappings with REAL scrip-master tokens ---
  // (Dhan securityIds + Noren tsyms from the public master files —
  //  synthetic tokens cannot query real broker quotes/orders)
  let enrichNote = ''
  try {
    const { enrichBrokerMappings } = await import('./scrip-master')
    const er = await enrichBrokerMappings()
    enrichNote = er.notes.length ? ` · ${er.notes.join(' · ')}` : ''
  } catch (e) {
    enrichNote = ` · scrip-master enrichment skipped: ${e instanceof Error ? e.message : String(e)}`
  }

  await db.syncLog.create({
    data: { source, exchange: 'ALL', symbolCount, mappedCount, status: 'SUCCESS', message: `Synced ${symbolCount} symbols, ${mappedCount} broker mappings${enrichNote}`, version },
  })
  await db.systemSetting.upsert({
    where: { key: 'lastMasterSync' },
    create: { key: 'lastMasterSync', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  return { symbolCount, mappedCount, version }
}

export async function publishUniverseToFeed(masterRows: { symbol: string; basePrice: number | null; lotSize: number; instrumentType: string }[]) {
  try {
    const universe = masterRows.map(m => ({
      symbol: m.symbol,
      basePrice: m.basePrice ?? 1000,
      lotSize: m.lotSize,
      instrumentType: m.instrumentType,
    }))
    await fetch(`${FEED_URL}/universe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ universe }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // feed service may still be booting — it pulls the universe lazily too
  }
}

export async function isMasterSynced(): Promise<boolean> {
  const count = await db.symbolMaster.count()
  return count > 0
}
