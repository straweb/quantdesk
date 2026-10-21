import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { newId } from '../../../brokers/registry'
import { fetchQuotes } from '../../../brokers/feed-client'
import { placeMasterOrder, cancelAllOrders } from './order-router'
import { getChainMeta, ensureOptionContracts } from './option-service'
import { logBroker } from '../../../brokers/database'

// ============================================================
// Auto-rules engine v2 — the "auto bot".
//
// Trigger kinds:
//  · TIME        — fires at HH:MM:SS IST (seconds precision; 250ms
//                  scheduler so the fire lands within the second)
//  · INDEX       — spot crosses ABOVE/BELOW a level (edge-triggered)
//  · INDEX_RANGE — spot enters a [lo, hi] band (edge-triggered)
//
// Actions:
//  · BUY / SELL — option entry (MARKET, or LIMIT when entryPrice set)
//  · DEPLOY     — buy the full strike list of one side (CE or PE)
//  · CANCEL     — cancel pending orders on that side's strike list
//
// Optional risk legs (any subset, all optional):
//  · entryPrice — LIMIT entry instead of MARKET
//  · stopLoss   — reduce-only SL-M armed on the resulting position
//  · target     — reduce-only LIMIT armed on the resulting position
//
// Strike selection: rule.strikes [{strike, type, allocPct}] (user
// picked), or side-ATM + offset when the list is empty.
// Rules run server-side (250ms scheduler in instrumentation) so they
// fire even when no terminal tab is open. Storage: db/auto-rules.json.
// ============================================================

export type AutoRuleKind = 'INDEX' | 'INDEX_RANGE' | 'TIME'
export type AutoRuleAction = 'BUY' | 'SELL' | 'DEPLOY' | 'CANCEL'

export interface AutoStrike { strike: number; type: 'CE' | 'PE'; allocPct: number }

export interface AutoRule {
  id: string
  name: string
  underlying: string
  expiry: string | null
  kind: AutoRuleKind
  // INDEX trigger
  level?: number
  cross?: 'ABOVE' | 'BELOW'
  // INDEX_RANGE trigger
  lo?: number
  hi?: number
  // TIME trigger (HH:MM:SS IST)
  time?: string
  // action
  action: AutoRuleAction
  optType: 'CE' | 'PE'
  offset: number // steps from side ATM (0 = ATM) — used when strikes list empty
  strikes?: AutoStrike[] // user-selected strikes / strike set
  allocPct: number // % of each enabled account's usable capital (default for strikes without own alloc)
  // optional price legs (any subset)
  entryPrice?: number
  stopLoss?: number
  target?: number
  enabled: boolean
  repeatDaily: boolean
  lastFiredDate?: string
  lastFiredAt?: string
  lastStatus?: string
  lastMessage?: string
  fireCount: number
  createdAt: string
}

const RULES_FILE = path.join(process.cwd(), 'db', 'auto-rules.json')

async function readRules(): Promise<AutoRule[]> {
  try {
    const raw = await readFile(RULES_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { rules?: AutoRule[] }
    return Array.isArray(parsed.rules) ? parsed.rules : []
  } catch {
    return []
  }
}

async function writeRules(rules: AutoRule[]) {
  await mkdir(path.dirname(RULES_FILE), { recursive: true })
  await writeFile(RULES_FILE, JSON.stringify({ rules, updatedAt: new Date().toISOString() }, null, 2))
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n !== 0 ? n : undefined
}

// ---- CRUD (used by the API routes) ----

export async function listRules(): Promise<AutoRule[]> {
  return readRules()
}

export async function createRule(input: Partial<AutoRule>): Promise<AutoRule> {
  const rules = await readRules()
  const timeStr = typeof input.time === 'string' ? input.time.trim() : ''
  const timeOk = /^\d{1,2}:\d{2}(:\d{2})?$/.test(timeStr)
    ? timeStr.split(':').map(p => p.padStart(2, '0')).join(':')
    : undefined
  const kind: AutoRuleKind = input.kind === 'TIME' ? 'TIME' : input.kind === 'INDEX_RANGE' ? 'INDEX_RANGE' : 'INDEX'
  const strikes: AutoStrike[] = Array.isArray(input.strikes)
    ? (input.strikes as AutoStrike[])
        .filter(s => Number.isFinite(Number(s.strike)) && (s.type === 'CE' || s.type === 'PE'))
        .slice(0, 24)
        .map(s => ({ strike: Math.round(Number(s.strike)), type: s.type, allocPct: Math.max(1, Math.min(100, Number(s.allocPct ?? input.allocPct ?? 100))) }))
    : []
  const rule: AutoRule = {
    id: newId('AR-'),
    name: String(input.name || 'Untitled rule').slice(0, 80),
    underlying: String(input.underlying || ''),
    expiry: input.expiry ?? null,
    kind,
    level: num(input.level),
    cross: input.cross === 'BELOW' ? 'BELOW' : 'ABOVE',
    lo: num(input.lo),
    hi: num(input.hi),
    time: kind === 'TIME' ? timeOk : undefined,
    action: input.action === 'SELL' ? 'SELL' : input.action === 'DEPLOY' ? 'DEPLOY' : input.action === 'CANCEL' ? 'CANCEL' : 'BUY',
    optType: input.optType === 'PE' ? 'PE' : 'CE',
    offset: Math.max(-9, Math.min(9, Math.round(Number(input.offset ?? 0)) || 0)),
    strikes,
    allocPct: Math.max(1, Math.min(100, Number(input.allocPct ?? 100))),
    entryPrice: num(input.entryPrice),
    stopLoss: num(input.stopLoss),
    target: num(input.target),
    enabled: input.enabled !== false,
    repeatDaily: input.repeatDaily !== false,
    fireCount: 0,
    createdAt: new Date().toISOString(),
  }
  rules.push(rule)
  await writeRules(rules)
  return rule
}

export async function updateRule(id: string, patch: Partial<AutoRule>): Promise<AutoRule | null> {
  const rules = await readRules()
  const idx = rules.findIndex(r => r.id === id)
  if (idx === -1) return null
  const next = { ...rules[idx], ...patch, id: rules[idx].id }
  rules[idx] = next
  await writeRules(rules)
  return next
}

export async function deleteRule(id: string): Promise<boolean> {
  const rules = await readRules()
  const next = rules.filter(r => r.id !== id)
  if (next.length === rules.length) return false
  await writeRules(next)
  return true
}

// ---- engine ----

// Engine state lives on globalThis so Next.js dev hot-reloads can't stack
// duplicate intervals (module re-eval resets `let` state) and a single
// wedged tick can't stall the scheduler forever (timestamp busy guard).
const gEng = globalThis as unknown as {
  __autoRuleTimer?: ReturnType<typeof setInterval>
  __autoRuleBusyAt?: number
  __autoRuleBeat?: number
  __autoPrevSpot?: Map<string, number>
  __autoRulesCache?: { rules: AutoRule[]; ts: number }
  __autoFiredToday?: Map<string, string> // ruleId -> IST date (immediate dedupe;
  // the 2s rules cache is too stale to dedupe a seconds-precision fire window)
}

function istNow(): { date: string; secondsOfDay: number } {
  const d = new Date(Date.now() + 5.5 * 3600_000)
  const date = d.toISOString().slice(0, 10)
  const secondsOfDay = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
  return { date, secondsOfDay }
}

function timeToSeconds(t: string): number {
  const [hh = '0', mm = '0', ss = '0'] = t.split(':')
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss || 0)
}

async function loadRulesCached(): Promise<AutoRule[]> {
  const c = gEng.__autoRulesCache
  if (c && Date.now() - c.ts < 2000) return c.rules
  const rules = await readRules()
  gEng.__autoRulesCache = { rules, ts: Date.now() }
  return rules
}

/** Resolve the contract symbol for a strike/type and place the order.
 *  Side/action semantics:
 *   BUY/SELL/DEPLOY -> entry order (DEPLOY is always BUY of the side list)
 *   CANCEL          -> pending orders of those symbols are cancelled. */
async function executeStrikes(rule: AutoRule, list: AutoStrike[]): Promise<{ ok: boolean; message: string }> {
  if (list.length === 0) return { ok: false, message: 'no strikes to execute' }
  const meta = await getChainMeta(rule.underlying, rule.expiry)
  if (!meta) return { ok: false, message: `no option chain for ${rule.underlying}` }

  if (rule.action === 'CANCEL') {
    const symbols = list.map(s => `${rule.underlying}${meta.expiry.replaceAll('-', '')}${s.strike}${s.type}`)
    const cancelled = await cancelAllOrders(symbols)
    return { ok: cancelled > 0, message: `cancelled ${cancelled} pending order(s)` }
  }

  const side = rule.action === 'SELL' ? 'SELL' : 'BUY'
  let fills = 0, legs = 0, fails = 0
  const filledSymbols: { symbol: string; lots: number }[] = []
  for (const s of list) {
    try {
      await ensureOptionContracts(rule.underlying, s.strike, meta.expiry)
      const symbol = `${rule.underlying}${meta.expiry.replaceAll('-', '')}${s.strike}${s.type}`
      const res = await placeMasterOrder({
        symbol,
        exchange: 'NFO',
        side,
        qty: 0,
        orderType: rule.entryPrice ? 'LIMIT' : 'MARKET',
        productType: 'MIS',
        source: 'SYSTEM',
        capitalPct: s.allocPct ?? rule.allocPct,
        limitPrice: rule.entryPrice,
        strategyId: `auto:${rule.id}`,
      })
      const f = res.legs.filter(l => l.status === 'FILLED').length
      fills += f
      legs += res.legs.length
      if (f === 0) fails++
      else filledSymbols.push({ symbol, lots: 9999 })
    } catch {
      fails++
    }
  }

  // optional risk legs on the resulting positions (per account, capped at held)
  if (filledSymbols.length > 0 && (rule.stopLoss || rule.target)) {
    await armRiskLegs(rule, filledSymbols.map(f => f.symbol), meta.lotSize)
  }

  return {
    ok: fills > 0,
    message: `${side} ${list.length} strike(s) — ${fills}/${legs} account fills${fails ? ` · ${fails} strike fails` : ''}${rule.entryPrice ? ` @ LIMIT ${rule.entryPrice}` : ' @ MKT'}`,
  }
}

/** Arm reduce-only target (LIMIT) / stopLoss (SL-M) legs on whatever the
 *  rule's entry just bought/sold — executed by the resting-order monitor. */
async function armRiskLegs(rule: AutoRule, symbols: string[], _lotSize: number) {
  for (const symbol of symbols) {
    try {
      if (rule.target) {
        const posSide = rule.action === 'SELL' ? 'BUY' : 'SELL' // close the entry side
        await placeMasterOrder({
          symbol, exchange: 'NFO', side: posSide, qty: 9999,
          orderType: 'LIMIT', productType: 'MIS', source: 'SYSTEM',
          limitPrice: rule.target, reduceOnly: true, strategyId: 'reduce',
        })
      }
      if (rule.stopLoss) {
        const posSide = rule.action === 'SELL' ? 'BUY' : 'SELL'
        await placeMasterOrder({
          symbol, exchange: 'NFO', side: posSide, qty: 9999,
          orderType: 'SL-M', productType: 'MIS', source: 'SYSTEM',
          triggerPrice: rule.stopLoss, reduceOnly: true, strategyId: 'reduce',
        })
      }
    } catch { /* risk legs best-effort */ }
  }
}

/** Build the strike list for a rule: user picks win; else side-ATM + offset. */
async function strikesFor(rule: AutoRule): Promise<AutoStrike[]> {
  const wanted = rule.action === 'DEPLOY' || rule.action === 'CANCEL'
    ? (rule.strikes ?? []).filter(s => s.type === rule.optType)
    : rule.strikes ?? []
  if (wanted.length > 0) return wanted
  const meta = await getChainMeta(rule.underlying, rule.expiry)
  if (!meta) return []
  const sideAtm = rule.optType === 'CE' ? meta.ceAtm : meta.peAtm
  return [{ strike: sideAtm + rule.offset * meta.step, type: rule.optType, allocPct: rule.allocPct }]
}

async function fireRule(rule: AutoRule): Promise<{ ok: boolean; message: string }> {
  try {
    const list = await strikesFor(rule)
    return await executeStrikes(rule, list)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'fire failed' }
  }
}

async function markFired(rule: AutoRule, ok: boolean, message: string) {
  await updateRule(rule.id, {
    lastFiredDate: istNow().date,
    lastFiredAt: new Date().toISOString(),
    lastStatus: ok ? 'FIRED' : 'FAILED',
    lastMessage: message.slice(0, 160),
    fireCount: (rule.fireCount ?? 0) + 1,
  })
  logBroker('SIMFEED', 'auto-rules', `rule "${rule.name}" ${ok ? 'FIRED' : 'FAILED'}: ${message}`, ok ? 'INFO' : 'WARN')
}

/** Run `fireRule` with a hard timeout so one slow broker call can never wedge the loop. */
function fireWithTimeout(rule: AutoRule, ms = 20_000): Promise<{ ok: boolean; message: string }> {
  return Promise.race([
    fireRule(rule),
    new Promise<{ ok: false; message: string }>(res => setTimeout(() => res({ ok: false, message: 'fire timed out' }), ms)),
  ])
}

/** In-memory once-per-day guard — consulted BEFORE firing so a stale rules
 *  cache (2s TTL) can't double-fire inside a seconds-precision window. */
function alreadyFiredToday(rule: AutoRule): boolean {
  if (!rule.repeatDaily) return rule.lastFiredDate != null || (gEng.__autoFiredToday?.has(rule.id) ?? false)
  const today = istNow().date
  if (gEng.__autoFiredToday?.get(rule.id) === today) return true
  return rule.lastFiredDate === today
}

function markFiredMemory(ruleId: string): void {
  if (!gEng.__autoFiredToday) gEng.__autoFiredToday = new Map()
  gEng.__autoFiredToday.set(ruleId, istNow().date)
}

async function engineOnce() {
  const busyAt = gEng.__autoRuleBusyAt ?? 0
  if (busyAt && Date.now() - busyAt < 30_000) return // previous tick still inside its grace window
  gEng.__autoRuleBusyAt = Date.now()
  // heartbeat: prove the scheduler is alive (once a minute)
  if (!gEng.__autoRuleBeat || Date.now() - gEng.__autoRuleBeat > 60_000) {
    gEng.__autoRuleBeat = Date.now()
    console.log('[auto-rules] tick ok (250ms scheduler)')
  }
  try {
    const rules = await loadRulesCached()
    const { date, secondsOfDay } = istNow()
    const active = rules.filter(r => r.enabled && r.underlying)

    // ---- TIME rules (HH:MM:SS, fires within 2s of the target second) ----
    for (const rule of active.filter(r => r.kind === 'TIME' && r.time)) {
      if (alreadyFiredToday(rule)) continue
      const target = timeToSeconds(rule.time!)
      if (secondsOfDay < target || secondsOfDay >= target + 2) continue // 2s late grace
      markFiredMemory(rule.id)
      const out = await fireWithTimeout(rule)
      await markFired(rule, out.ok, out.message)
    }

    // ---- INDEX + INDEX_RANGE rules (edge-triggered, 250ms sampling) ----
    const indexRules = active.filter(r =>
      (r.kind === 'INDEX' && r.level != null) || (r.kind === 'INDEX_RANGE' && r.lo != null && r.hi != null))
    if (indexRules.length > 0) {
      const unds = [...new Set(indexRules.map(r => r.underlying))]
      const quotes = await fetchQuotes(unds)
      for (const rule of indexRules) {
        const q = quotes[rule.underlying]
        if (!q) continue
        if (!gEng.__autoPrevSpot) gEng.__autoPrevSpot = new Map()
        const prev = gEng.__autoPrevSpot.get(rule.id)
        gEng.__autoPrevSpot.set(rule.id, q.ltp)
        if (prev == null) continue // first observation — arm only
        if (alreadyFiredToday(rule)) continue
        let hit = false
        if (rule.kind === 'INDEX' && rule.level != null) {
          const crossedUp = prev < rule.level && q.ltp >= rule.level
          const crossedDown = prev > rule.level && q.ltp <= rule.level
          hit = rule.cross === 'BELOW' ? crossedDown : crossedUp
        } else if (rule.kind === 'INDEX_RANGE' && rule.lo != null && rule.hi != null) {
          const inside = q.ltp >= rule.lo && q.ltp <= rule.hi
          const wasInside = prev >= rule.lo && prev <= rule.hi
          hit = inside && !wasInside // entered the band
        }
        if (!hit) continue
        markFiredMemory(rule.id)
        const out = await fireWithTimeout(rule)
        await markFired(rule, out.ok, out.message)
      }
    }
  } catch (e) {
    console.error('[auto-rules]', e)
  } finally {
    gEng.__autoRuleBusyAt = 0
  }
}

export function ensureAutoRuleEngine() {
  if (gEng.__autoRuleTimer) return
  gEng.__autoRuleTimer = setInterval(() => { void engineOnce() }, 250)
  console.log('[auto-rules] engine started (250ms scheduler — seconds precision)')
}
