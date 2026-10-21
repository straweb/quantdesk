import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { newId } from '../../../brokers/registry'
import { fetchQuotes } from '../../../brokers/feed-client'
import { placeMasterOrder } from './order-router'
import { getChainMeta, ensureOptionContracts } from './option-service'
import { logBroker } from '../../../brokers/database'

// ============================================================
// Auto-rules engine — index-level and time-based CE/PE entries.
//
// Rule kinds:
//  · INDEX  — fires when the underlying spot crosses ABOVE/BELOW
//             a level (edge-triggered, one shot per crossing)
//  · TIME   — fires at HH:MM IST (5-minute late-grace window),
//             once per day
//
// Action: BUY/SELL CE/PE at side-ATM + offset steps (hedge-desk
// ATM convention), auto-sized per account via capitalPct.
// Rules run server-side (1s scheduler in instrumentation) so they
// fire even when no terminal tab is open. Storage: db/auto-rules.json.
// ============================================================

export type AutoRuleKind = 'INDEX' | 'TIME'

export interface AutoRule {
  id: string
  name: string
  underlying: string
  expiry: string | null
  kind: AutoRuleKind
  // INDEX trigger
  level?: number
  cross?: 'ABOVE' | 'BELOW'
  // TIME trigger (HH:MM IST)
  time?: string
  // action
  action: 'BUY' | 'SELL'
  optType: 'CE' | 'PE'
  offset: number // steps from side ATM (0 = ATM)
  allocPct: number // % of each enabled account's usable capital
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

// ---- CRUD (used by the API routes) ----

export async function listRules(): Promise<AutoRule[]> {
  return readRules()
}

export async function createRule(input: Partial<AutoRule>): Promise<AutoRule> {
  const rules = await readRules()
  const rule: AutoRule = {
    id: newId('AR-'),
    name: String(input.name || 'Untitled rule').slice(0, 60),
    underlying: String(input.underlying || ''),
    expiry: input.expiry ?? null,
    kind: input.kind === 'TIME' ? 'TIME' : 'INDEX',
    level: input.level != null && Number.isFinite(Number(input.level)) ? Number(input.level) : undefined,
    cross: input.cross === 'BELOW' ? 'BELOW' : 'ABOVE',
    time: typeof input.time === 'string' && /^\d{2}:\d{2}$/.test(input.time) ? input.time : undefined,
    action: input.action === 'SELL' ? 'SELL' : 'BUY',
    optType: input.optType === 'PE' ? 'PE' : 'CE',
    offset: Math.max(-9, Math.min(9, Math.round(Number(input.offset ?? 0)) || 0)),
    allocPct: Math.max(1, Math.min(100, Number(input.allocPct ?? 100))),
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
}

function istNow(): { date: string; minutes: number } {
  const d = new Date(Date.now() + 5.5 * 3600_000)
  const date = d.toISOString().slice(0, 10)
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  return { date, minutes }
}

async function loadRulesCached(): Promise<AutoRule[]> {
  const c = gEng.__autoRulesCache
  if (c && Date.now() - c.ts < 2000) return c.rules
  const rules = await readRules()
  gEng.__autoRulesCache = { rules, ts: Date.now() }
  return rules
}

/** Resolve the contract symbol for side-ATM + offset and place the order. */
async function fireRule(rule: AutoRule): Promise<{ ok: boolean; message: string }> {
  try {
    const meta = await getChainMeta(rule.underlying, rule.expiry)
    if (!meta) return { ok: false, message: `no option chain for ${rule.underlying}` }
    const sideAtm = rule.optType === 'CE' ? meta.ceAtm : meta.peAtm
    const strike = sideAtm + rule.offset * meta.step
    await ensureOptionContracts(rule.underlying, strike, meta.expiry)
    const symbol = `${rule.underlying}${meta.expiry.replaceAll('-', '')}${strike}${rule.optType}`
    const res = await placeMasterOrder({
      symbol,
      exchange: 'NFO',
      side: rule.action,
      qty: 0,
      orderType: 'MARKET',
      productType: 'MIS',
      source: 'SYSTEM',
      capitalPct: rule.allocPct,
      strategyId: `auto:${rule.id}`,
    })
    const fills = res.legs.filter(l => l.status === 'FILLED').length
    return {
      ok: fills > 0,
      message: `${rule.action} ${strike} ${rule.optType} (${rule.underlying}) — ${fills}/${res.legs.length} account fills`,
    }
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

async function engineOnce() {
  const busyAt = gEng.__autoRuleBusyAt ?? 0
  if (busyAt && Date.now() - busyAt < 30_000) return // previous tick still inside its grace window
  gEng.__autoRuleBusyAt = Date.now()
  // heartbeat: prove the scheduler is alive (once a minute)
  if (!gEng.__autoRuleBeat || Date.now() - gEng.__autoRuleBeat > 60_000) {
    gEng.__autoRuleBeat = Date.now()
    console.log('[auto-rules] tick ok')
  }
  try {
    const rules = await loadRulesCached()
    const { date, minutes } = istNow()
    const active = rules.filter(r => r.enabled && r.underlying)

    // ---- TIME rules ----
    for (const rule of active.filter(r => r.kind === 'TIME' && r.time)) {
      if (rule.repeatDaily && rule.lastFiredDate === date) continue
      if (!rule.repeatDaily && rule.lastFiredDate) continue
      const [hh, mm] = rule.time!.split(':').map(Number)
      const target = hh * 60 + mm
      if (minutes < target || minutes >= target + 5) continue // 5-min late grace
      const out = await fireWithTimeout(rule)
      await markFired(rule, out.ok, out.message)
    }

    // ---- INDEX rules (edge-triggered crossings) ----
    const indexRules = active.filter(r => r.kind === 'INDEX' && r.level != null)
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
        const level = rule.level!
        const crossedUp = prev < level && q.ltp >= level
        const crossedDown = prev > level && q.ltp <= level
        const hit = rule.cross === 'BELOW' ? crossedDown : crossedUp
        if (!hit) continue
        if (rule.repeatDaily && rule.lastFiredDate === date) continue
        if (!rule.repeatDaily && rule.lastFiredDate) continue
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
  gEng.__autoRuleTimer = setInterval(() => { void engineOnce() }, 1000)
  console.log('[auto-rules] engine started (1s scheduler)')
}
