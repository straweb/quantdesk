'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { Candle, Tick } from '@/lib/types'
import { TF_MS } from '@/lib/types'
import { api } from '../lib/client-api'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'

// ============================================================
// From-scratch canvas candlestick chart — no charting library.
// Candles / line / area + volume histogram + indicator panels.
//   · wheel on plot / time axis  -> time zoom (bars)
//   · wheel on price axis / +Shift -> price-scale-only zoom
//   · drag plot                   -> free pan (left/right/top/bottom)
//   · drag price axis             -> squeeze/stretch price scale
//   · drag time axis              -> pan time
//   · double-click / ▶LIVE button -> reset view to live edge
//   · panning right shows up to 50 bars of FUTURE space
// Legend (title + O/H/L/C/V + LTP) is ALWAYS visible; hovering
// switches it to the hovered candle. Crosshair is SYNCED across
// every open chart locked to the same interval (timeframe).
// Overlays: SMA20/50, EMA9/21, VWAP (session), Bollinger(20,2).
// Sub-panels: RSI(14), MACD(12,26,9).
// ============================================================

export interface ChartMarker { price: number; label: string; color: string }

/** Blank bars the user can pan into beyond the live edge. */
export const FUTURE_BARS = 50

/** Axis scales (sample-tool "SCALES" popup): topmost enabled scale gets the
 *  right axis, the others render as a left measurement column. % / pts are
 *  relative to a baseline the user can drag or set by clicking the chart. */
export interface ScalesCfg { price: boolean; pct: boolean; inv: boolean; pts: boolean }

interface Props {
  symbol: string
  tf: string
  chartType: 'candles' | 'line' | 'area'
  showVolume: boolean
  showSMA20: boolean
  showSMA50: boolean
  showEMA?: boolean
  showVWAP?: boolean
  showBOLL?: boolean
  showRSI?: boolean
  showMACD?: boolean
  // 1M ghost: overlay 1m candles on higher-timeframe charts (hollow/fade)
  showGhost?: boolean
  ghostStyle?: 'hollow' | 'fade'
  scales?: ScalesCfg
  markers?: ChartMarker[]
  onPriceClick?: (price: number) => void
  height: string
  mini?: boolean // compact mode (option panes): thinner axes
}

const UP = '#00c896'
const DOWN = '#ff4d5e'
const GRID = 'rgba(255,255,255,0.045)'
const AXIS_TXT = '#8b949e'
const CROSS = 'rgba(255,255,255,0.25)'

// ---------------- indicator math ----------------

function sma(data: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    sum += data[i].c
    if (i >= period) sum -= data[i - period].c
    out.push(i >= period - 1 ? sum / period : null)
  }
  return out
}

function ema(data: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  const k = 2 / (period + 1)
  let prev = 0
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { out.push(null); prev += data[i].c; continue }
    if (i === period - 1) { prev = (prev + data[i].c) / period; out.push(prev); continue }
    prev = data[i].c * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

/** Session VWAP — resets each calendar day (IST) like real intraday VWAP. */
function vwap(data: Candle[]): (number | null)[] {
  const out: (number | null)[] = []
  let day = '', cumPV = 0, cumV = 0
  for (const c of data) {
    const d = new Date(c.t + 5.5 * 3600_000).toISOString().slice(0, 10) // IST day bucket
    if (d !== day) { day = d; cumPV = 0; cumV = 0 }
    const tp = (c.h + c.l + c.c) / 3
    cumPV += tp * (c.v || 1)
    cumV += c.v || 1
    out.push(cumV > 0 ? cumPV / cumV : null)
  }
  return out
}

function bollinger(data: Candle[], period = 20, mult = 2) {
  const mid = sma(data, period)
  const up: (number | null)[] = []
  const lo: (number | null)[] = []
  for (let i = 0; i < data.length; i++) {
    if (mid[i] == null) { up.push(null); lo.push(null); continue }
    let s = 0
    for (let j = i - period + 1; j <= i; j++) s += (data[j].c - mid[i]!) ** 2
    const sd = Math.sqrt(s / period)
    up.push(mid[i]! + mult * sd)
    lo.push(mid[i]! - mult * sd)
  }
  return { mid, up, lo }
}

function rsi(data: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = []
  let avgG = 0, avgL = 0
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { out.push(null); continue }
    const ch = data[i].c - data[i - 1].c
    const g = Math.max(0, ch), l = Math.max(0, -ch)
    if (i <= period) {
      avgG += g / period; avgL += l / period
      out.push(i === period ? toRsi(avgG, avgL) : null)
      continue
    }
    avgG = (avgG * (period - 1) + g) / period
    avgL = (avgL * (period - 1) + l) / period
    out.push(toRsi(avgG, avgL))
  }
  return out
}
function toRsi(g: number, l: number): number | null {
  if (l === 0) return 100
  const rs = g / l
  return 100 - 100 / (1 + rs)
}

function macd(data: Candle[], fast = 12, slow = 26, sig = 9) {
  const ef = ema(data, fast)
  const es = ema(data, slow)
  const line = data.map((_, i) => (ef[i] != null && es[i] != null ? ef[i]! - es[i]! : null))
  // signal = EMA9 of the macd line (skip nulls at head)
  const signal: (number | null)[] = []
  const k = 2 / (sig + 1)
  let prev = 0
  let seeded = false
  for (let i = 0; i < data.length; i++) {
    if (line[i] == null) { signal.push(null); continue }
    if (!seeded) { prev = line[i]!; seeded = true; signal.push(prev); continue }
    prev = line[i]! * k + prev * (1 - k)
    signal.push(prev)
  }
  const hist = data.map((_, i) => (line[i] != null && signal[i] != null ? line[i]! - signal[i]! : null))
  return { line, signal, hist }
}

// ---------------- crosshair sync bus ----------------
// Every chart publishes its hovered candle time; charts running the
// same interval draw a synced crosshair + legend values at that time.

export interface CrossSyncMsg { src: number; tf: string; t: number | null; price: number | null }
const crossBusListeners = new Set<(m: CrossSyncMsg) => void>()
let CHART_SEQ = 0

function emitCross(m: CrossSyncMsg) {
  for (const fn of crossBusListeners) fn(m)
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min
  if (span <= 0) return [min]
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max; v += step) out.push(v)
  return out
}

function fmtAxisTime(t: number, tf: string): string {
  const d = new Date(t)
  if (tf === '1d') return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function fmtVol(v: number): string {
  if (v >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`
  if (v >= 1e5) return `${(v / 1e5).toFixed(1)}L`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(Math.round(v))
}

// ---- scale labels (percent / points vs baseline) ----
function labelPct(v: number): string {
  const s = v >= 0 ? '+' : '-', a = Math.abs(v)
  return s + (a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2)) + '%'
}
function labelPts(v: number): string {
  const s = v >= 0 ? '+' : '-', a = Math.abs(v)
  return s + (a >= 1000 ? a.toFixed(0) : a >= 100 ? a.toFixed(1) : a.toFixed(2))
}

// baseline pick-mode bus (toolbar "Set base" button arms ALL charts;
// the next chart click consumes it)
const BASE_PICK_EVENT = 'qd-chart-set-base'
const BASE_SET_EVENT = 'qd-chart-base-set'

function lowerBoundTime(arr: Candle[], t: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid }
  return lo
}

interface DragState {
  zone: 'plot' | 'price' | 'time' | 'base'
  startX: number
  startY: number
  startOffset: number
  startPriceOff: number
  startPriceZoom: number
  pxPerPx: number
  moved: number
}

export function CanvasChart({
  symbol, tf, chartType, showVolume, showSMA20, showSMA50,
  showEMA = false, showVWAP = false, showBOLL = false, showRSI = false, showMACD = false,
  showGhost = false, ghostStyle = 'hollow', scales,
  markers = [], onPriceClick, height, mini = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [barCount, setBarCount] = useState(mini ? 60 : 120)
  const [dirty, setDirty] = useState(false) // false = view pinned to live edge
  const offsetRef = useRef(0) // bars panned; NEGATIVE = into future space
  const priceZoomRef = useRef(1)
  const priceOffRef = useRef(0)
  const [, forceRender] = useState(0)
  const crossRef = useRef<{ x: number; y: number } | null>(null)
  const syncCrossRef = useRef<{ slot: number; price: number | null } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const sizeRef = useRef({ w: 0, h: 0 })
  const winRef = useRef({ w: 0, h: 0, plotW: 0, priceH: 0, axisH: mini ? 12 : 20, pMin: 0, pMax: 1 })
  const lastRangeRef = useRef({ pMin: 0, pMax: 1 }) // survives full-future views
  const lastVolRef = useRef<Record<string, number>>({})
  const chartId = useRef(++CHART_SEQ)
  // ---- 1M ghost overlay ----
  const [ghost, setGhost] = useState<Candle[]>([])
  // ---- scales baseline (null = day open ref) + pick mode ----
  const baseRef = useRef<number | null>(null)
  const pickRef = useRef(false)
  const [baseArmed, setBaseArmed] = useState(false)
  // last-drawn baseline geometry (for the grab zone) — updated every frame
  const drawMetaRef = useRef({ yBase: -1, baseline: 0 })

  // ---- baseline pick-mode bus (armed from the toolbar SCALES popover) ----
  useEffect(() => {
    const arm = () => { pickRef.current = true; setBaseArmed(true) }
    const disarm = () => { pickRef.current = false; setBaseArmed(false) }
    window.addEventListener(BASE_PICK_EVENT, arm)
    window.addEventListener(BASE_SET_EVENT, disarm)
    return () => {
      window.removeEventListener(BASE_PICK_EVENT, arm)
      window.removeEventListener(BASE_SET_EVENT, disarm)
    }
  }, [])

  // ---- crosshair sync (same tf only — charts are interval-locked) ----
  useEffect(() => {
    const fn = (m: CrossSyncMsg) => {
      if (m.src === chartId.current || m.tf !== tf) { return }
      if (m.t == null) { syncCrossRef.current = null; return }
      syncCrossRef.current = { slot: m.t, price: m.price } // slot stores t; resolved in draw
      forceRender(n => n + 1)
    }
    crossBusListeners.add(fn)
    return () => { crossBusListeners.delete(fn) }
  }, [tf])

  // ---- data loading ----
  const load = useCallback(async () => {
    if (!symbol) return
    try {
      const r = await api.candles(symbol, tf as never, 1000)
      if (r.candles?.length) {
        setCandles(r.candles)
        lastVolRef.current = { [symbol]: r.candles[r.candles.length - 1]?.v ?? 0 }
      }
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load failed')
    } finally {
      setLoading(false)
    }
  }, [symbol, tf])

  useEffect(() => {
    setLoading(true)
    offsetRef.current = 0
    priceZoomRef.current = 1
    priceOffRef.current = 0
    setDirty(false)
    load()
    subscribeTicks([symbol])
    const iv = setInterval(load, 30_000)
    return () => {
      unsubscribeTicks([symbol])
      clearInterval(iv)
    }
  }, [symbol, tf, load])

  // ---- 1m ghost data (only meaningful on higher timeframes) ----
  useEffect(() => {
    if (!showGhost || tf === '1m') { setGhost([]); return }
    let dead = false
    const pull = async () => {
      try {
        const r = await api.candles(symbol, '1m' as never, 1200)
        if (!dead) setGhost(r.candles ?? [])
      } catch { /* ghost is best-effort */ }
    }
    pull()
    const iv = setInterval(pull, 30_000)
    return () => { dead = true; clearInterval(iv) }
  }, [symbol, tf, showGhost])

  // ---- live ticks merge into the last candle ----
  useEffect(() => {
    return onTicks(map => {
      const t: Tick | undefined = map[symbol]
      if (!t) return
      setCandles(prev => {
        if (prev.length === 0) return prev
        const arr = prev.slice()
        const last = { ...arr[arr.length - 1] }
        const bucket = Math.floor(t.ts / TF_MS[tf as keyof typeof TF_MS]) * TF_MS[tf as keyof typeof TF_MS]
        const dayVolDelta = Math.max(0, t.vol - (lastVolRef.current[symbol] ?? t.vol))
        lastVolRef.current[symbol] = t.vol
        if (bucket > last.t) {
          arr.push({ t: bucket, o: t.ltp, h: t.ltp, l: t.ltp, c: t.ltp, v: dayVolDelta })
          if (arr.length > 1600) arr.splice(0, 200)
        } else {
          last.c = t.ltp
          last.h = Math.max(last.h, t.ltp)
          last.l = Math.min(last.l, t.ltp)
          last.v += dayVolDelta
          arr[arr.length - 1] = last
        }
        return arr
      })
      // ghost 1m last bar follows live ticks as well
      if (showGhost && tf !== '1m') {
        setGhost(prevG => {
          if (prevG.length === 0) return prevG
          const gArr = prevG.slice()
          const gl = { ...gArr[gArr.length - 1] }
          const gb = Math.floor(t.ts / 60_000) * 60_000
          if (gb > gl.t) {
            gArr.push({ t: gb, o: t.ltp, h: t.ltp, l: t.ltp, c: t.ltp, v: 0 })
            if (gArr.length > 2400) gArr.splice(0, 200)
          } else {
            gl.c = t.ltp
            gl.h = Math.max(gl.h, t.ltp)
            gl.l = Math.min(gl.l, t.ltp)
            gArr[gArr.length - 1] = gl
          }
          return gArr
        })
      }
    })
  }, [symbol, tf, showGhost])

  // ---- render loop ----
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    let raf = 0

    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (sizeRef.current.w !== w || sizeRef.current.h !== h || canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
        sizeRef.current = { w, h }
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.font = '10px ui-monospace, monospace'

      const data = candles
      if (data.length < 2) {
        ctx.fillStyle = AXIS_TXT
        ctx.textAlign = 'center'
        ctx.fillText(loading ? 'loading candles…' : err || 'no data', w / 2, h / 2)
        return
      }

      const axisW = mini ? 46 : 58
      const axisH = mini ? 12 : 20
      const plotW = w - axisW
      const availH = h - axisH
      const volH = showVolume ? Math.round(availH * (mini ? 0.14 : 0.16)) : 0
      const subSlot = Math.round(availH * 0.16)
      const rsiH = !mini && showRSI ? subSlot : 0
      const macdH = !mini && showMACD ? subSlot : 0
      const priceH = availH - (showVolume ? volH + 5 : 0) - rsiH - macdH

      // visible window — offset may be NEGATIVE (future space)
      const end = data.length - Math.round(offsetRef.current)
      const start = Math.min(end - barCount, data.length - 2)
      const slots = end - start
      if (slots < 2) { offsetRef.current = 0; return }
      const vis: (Candle | null)[] = new Array(slots)
      for (let i = 0; i < slots; i++) vis[i] = data[start + i] ?? null
      const lastC0 = data[data.length - 1]
      const lastT = data[data.length - 1].t
      const tfMs = TF_MS[tf as keyof typeof TF_MS] ?? 60_000
      const timeOfSlot = (i: number) => {
        const di = start + i
        return di < data.length ? data[di].t : lastT + (di - (data.length - 1)) * tfMs
      }

      // day-change reference (session open) — the default scales baseline
      const dayKey = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10)
      const todayKey = dayKey(lastT)
      let dayRef = lastC0.o
      for (let i = data.length - 1; i >= 0; i--) {
        if (dayKey(data[i].t) !== todayKey) break
        dayRef = data[i].o
      }
      const baseline = baseRef.current ?? dayRef
      const pctOf = (p: number) => (baseline ? ((p - baseline) / baseline) * 100 : 0)

      // price range over real candles + overlays
      let pMin = Infinity, pMax = -Infinity
      for (const c of vis) { if (!c) continue; if (c.l < pMin) pMin = c.l; if (c.h > pMax) pMax = c.h }
      // ghost 1m candles stretch the range too
      if (showGhost && ghost.length > 0 && tfMs > 60_000) {
        const tA = timeOfSlot(0), tB = timeOfSlot(slots - 1) + tfMs
        const g0 = lowerBoundTime(ghost, tA), g1 = lowerBoundTime(ghost, tB)
        for (let gi = g0; gi < g1; gi++) { const g = ghost[gi]; if (g.l < pMin) pMin = g.l; if (g.h > pMax) pMax = g.h }
      }
      const s20 = showSMA20 ? sma(data, 20) : null
      const s50 = showSMA50 ? sma(data, 50) : null
      const e9 = showEMA ? ema(data, 9) : null
      const e21 = showEMA ? ema(data, 21) : null
      const vw = showVWAP ? vwap(data) : null
      const bb = showBOLL ? bollinger(data) : null
      const includeSeries = (arr: (number | null)[] | null | undefined, up?: (number | null)[] | null, lo?: (number | null)[] | null) => {
        if (arr) for (let i = start; i < end; i++) { const v = arr[i]; if (v != null) { if (v < pMin) pMin = v; if (v > pMax) pMax = v } }
        if (up) for (let i = start; i < end; i++) { const v = up[i]; if (v != null) { if (v < pMin) pMin = v; if (v > pMax) pMax = v } }
        if (lo) for (let i = start; i < end; i++) { const v = lo[i]; if (v != null) { if (v < pMin) pMin = v; if (v > pMax) pMax = v } }
      }
      includeSeries(s20); includeSeries(s50); includeSeries(e9); includeSeries(e21); includeSeries(vw)
      if (bb) includeSeries(bb.mid, bb.up, bb.lo)
      for (const m of markers) { if (m.price < pMin) pMin = m.price; if (m.price > pMax) pMax = m.price }
      if (!isFinite(pMin) || !isFinite(pMax)) { pMin = lastRangeRef.current.pMin; pMax = lastRangeRef.current.pMax }
      const pad = (pMax - pMin) * 0.08 || pMax * 0.001 || 1
      pMin -= pad; pMax += pad
      lastRangeRef.current = { pMin, pMax }

      const zoom = priceZoomRef.current
      const center = (pMin + pMax) / 2
      const half = ((pMax - pMin) / 2) * zoom
      pMin = center - half + priceOffRef.current
      pMax = center + half + priceOffRef.current

      winRef.current = { w, h, plotW, priceH, axisH, pMin, pMax }

      const cw = plotW / slots
      const bodyW = Math.max(1, Math.min(14, cw * 0.68))
      const xOf = (i: number) => i * cw + cw / 2
      const yOf = (p: number) => ((pMax - p) / (pMax - pMin)) * priceH

      // ---- scales config: topmost enabled = right axis, others = left column ----
      const scalesCfg = scales ?? { price: true, pct: false, inv: false, pts: false }
      const enabledScales = (['price', 'pct', 'inv', 'pts'] as const).filter(k => scalesCfg[k])
      const primary = enabledScales[0] ?? 'price'
      const secondaries = enabledScales.slice(1)
      const scaleLabel = (p: number) =>
        primary === 'pct' ? labelPct(pctOf(p))
        : primary === 'inv' ? labelPct(-pctOf(p))
        : primary === 'pts' ? labelPts(p - baseline)
        : (p >= 1000 ? p.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : p.toFixed(2))

      // grid + price axis (labels follow the primary scale)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const tickList = niceTicks(pMin, pMax, Math.max(mini ? 2 : 3, Math.floor(priceH / (mini ? 90 : 55))))
      for (const p of tickList) {
        const y = yOf(p)
        ctx.strokeStyle = GRID
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
        ctx.fillStyle = AXIS_TXT
        ctx.fillText(scaleLabel(p), plotW + 6, y)
      }

      // ---- left measurement column (secondary scales, sample-tool style) ----
      const colW = secondaries.length > 0 ? 10 + Math.max(34, secondaries.length * 40) : 0
      if (colW > 0 && !mini) {
        ctx.fillStyle = 'rgba(11,14,17,0.66)'
        ctx.fillRect(0, 0, colW, priceH)
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'
        ctx.beginPath(); ctx.moveTo(colW, 0); ctx.lineTo(colW, priceH); ctx.stroke()
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        const yBase = yOf(baseline)
        for (const p of tickList) {
          const y = yOf(p)
          if (y < 8 || y > priceH - 8) continue
          let ly = y - (secondaries.length - 1) * 6
          for (const s of secondaries) {
            const v = s === 'pct' ? labelPct(pctOf(p)) : s === 'inv' ? labelPct(-pctOf(p)) : labelPts(p - baseline)
            ctx.fillStyle = s === 'pct' ? 'rgba(224,166,63,0.85)' : s === 'inv' ? 'rgba(224,106,159,0.85)' : 'rgba(77,208,225,0.85)'
            ctx.fillText(v, 3, ly)
            ly += 12
          }
        }
        // baseline marker in the column
        if (yBase >= 0 && yBase <= priceH) {
          ctx.fillStyle = 'rgba(224,166,63,0.95)'
          ctx.fillRect(0, yBase - 7, colW, 14)
          ctx.fillStyle = '#0b0e11'
          ctx.font = 'bold 9px ui-monospace, monospace'
          ctx.fillText('BASE', 3, yBase)
          ctx.font = '10px ui-monospace, monospace'
        }
      }

      // time axis (labels incl. future space)
      if (!mini) {
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const labelEvery = Math.max(1, Math.ceil(slots / Math.max(2, Math.floor(plotW / 90))))
        for (let i = 0; i < slots; i += labelEvery) {
          const x = xOf(i)
          ctx.strokeStyle = GRID
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - axisH); ctx.stroke()
          ctx.fillStyle = AXIS_TXT
          ctx.fillText(fmtAxisTime(timeOfSlot(i), tf), x, h - axisH + 4)
        }
        // future-space divider
        const fi = data.length - start
        if (fi > 0 && fi < slots) {
          const fx = xOf(fi) - cw / 2
          ctx.strokeStyle = 'rgba(139,148,158,0.28)'
          ctx.setLineDash([2, 4])
          ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, h - axisH); ctx.stroke()
          ctx.setLineDash([])
        }
      }

      // volume histogram
      if (showVolume && volH > 0) {
        let vMax = 0
        for (const c of vis) if (c && c.v > vMax) vMax = c.v
        const vy0 = priceH + 5 + volH
        vis.forEach((c, i) => {
          if (!c || c.v <= 0) return
          const vh = (c.v / vMax) * volH
          ctx.fillStyle = c.c >= c.o ? 'rgba(0,200,150,0.35)' : 'rgba(255,77,94,0.35)'
          ctx.fillRect(xOf(i) - bodyW / 2, vy0 - vh, bodyW, vh)
        })
        ctx.fillStyle = 'rgba(139,148,158,0.8)'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(`Vol ${fmtVol(vMax)}`, 4, vy0 - volH + 1)
      }

      // RSI panel
      const rsiArr = !mini && showRSI ? rsi(data) : null
      if (rsiArr && rsiH > 0) {
        const top = priceH + (showVolume ? 5 + volH + 2 : 2)
        const yR = (v: number) => top + ((100 - v) / 100) * rsiH
        ctx.strokeStyle = GRID
        ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(plotW, top); ctx.stroke()
        for (const g of [30, 70]) {
          ctx.strokeStyle = 'rgba(255,255,255,0.07)'
          ctx.setLineDash([2, 3])
          ctx.beginPath(); ctx.moveTo(0, yR(g)); ctx.lineTo(plotW, yR(g)); ctx.stroke()
          ctx.setLineDash([])
        }
        ctx.strokeStyle = '#f5a623'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        let st = false
        for (let i = start; i < end; i++) {
          const v = rsiArr[i]; if (v == null) { st = false; continue }
          const x = xOf(i - start), y = yR(v)
          if (!st) { ctx.moveTo(x, y); st = true } else ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.lineWidth = 1
        ctx.fillStyle = '#f5a623'
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'
        ctx.fillText('RSI14', 4, top + 1)
      }

      // MACD panel
      const macdArr = !mini && showMACD ? macd(data) : null
      if (macdArr && macdH > 0) {
        const top = priceH + (showVolume ? 5 + volH + 2 : 2) + (rsiH ? rsiH + 2 : 0)
        let mMin = Infinity, mMax = -Infinity
        for (let i = start; i < end; i++) {
          for (const arr of [macdArr.line, macdArr.signal, macdArr.hist]) {
            const v = arr[i]; if (v == null) continue
            if (v < mMin) mMin = v; if (v > mMax) mMax = v
          }
        }
        if (!isFinite(mMin)) { mMin = -1; mMax = 1 }
        const mAbs = Math.max(Math.abs(mMin), Math.abs(mMax)) || 1
        const yM = (v: number) => top + ((mAbs - v) / (2 * mAbs)) * macdH
        ctx.strokeStyle = GRID
        ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(plotW, top); ctx.stroke()
        // zero line
        ctx.strokeStyle = 'rgba(255,255,255,0.09)'
        ctx.beginPath(); ctx.moveTo(0, yM(0)); ctx.lineTo(plotW, yM(0)); ctx.stroke()
        vis.forEach((c, i) => {
          if (!c) return
          const v = macdArr.hist[start + i]; if (v == null) return
          const y0 = yM(0), y1 = yM(v)
          ctx.fillStyle = v >= 0 ? 'rgba(0,200,150,0.4)' : 'rgba(255,77,94,0.4)'
          ctx.fillRect(xOf(i) - bodyW / 2, Math.min(y0, y1), bodyW, Math.max(1, Math.abs(y1 - y0)))
        })
        const drawLine = (arr: (number | null)[], color: string) => {
          ctx.strokeStyle = color
          ctx.lineWidth = 1.2
          ctx.beginPath()
          let st = false
          for (let i = start; i < end; i++) {
            const v = arr[i]; if (v == null) { st = false; continue }
            const x = xOf(i - start), y = yM(v)
            if (!st) { ctx.moveTo(x, y); st = true } else ctx.lineTo(x, y)
          }
          ctx.stroke()
          ctx.lineWidth = 1
        }
        drawLine(macdArr.line, '#4dd0e1')
        drawLine(macdArr.signal, '#f5a623')
        ctx.fillStyle = '#4dd0e1'
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'
        ctx.fillText('MACD 12·26·9', 4, top + 1)
      }

      // ---- 1M ghost overlay (sample-tool #ghostCtl): 1m candles on >1m charts ----
      if (showGhost && ghost.length > 0 && tfMs > 60_000) {
        const tA = timeOfSlot(0), tB = timeOfSlot(slots - 1) + tfMs
        const g0 = lowerBoundTime(ghost, tA), g1 = lowerBoundTime(ghost, tB)
        if (g1 > g0) {
          ctx.lineWidth = 1
          ctx.textAlign = 'left'; ctx.textBaseline = 'top'
          for (let i = 0; i < slots; i++) {
            const t0 = timeOfSlot(i)
            if (t0 < ghost[0].t) continue
            const t1 = t0 + tfMs
            const lo = Math.max(g0, lowerBoundTime(ghost, t0))
            const hi = Math.min(g1, lowerBoundTime(ghost, t1))
            const k = hi - lo
            if (k <= 0) continue
            const bw = Math.max(1.5, Math.min(6, (cw / k) * 0.62))
            for (let j = 0; j < k; j++) {
              const g = ghost[lo + j]
              const x = xOf(i) - cw / 2 + ((j + 0.5) / k) * cw
              const up = g.c >= g.o
              const col = up ? UP : DOWN
              const yH = yOf(g.h), yL = yOf(g.l), yO = yOf(g.o), yC = yOf(g.c)
              if (Math.max(yH, yL) < -4 || Math.min(yH, yL) > priceH + 4) continue
              ctx.globalAlpha = ghostStyle === 'fade' ? 0.26 : 0.6
              ctx.strokeStyle = col
              ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke()
              const top = Math.min(yO, yC)
              const bh = Math.max(1, Math.abs(yC - yO))
              if (ghostStyle === 'hollow') {
                ctx.strokeRect(x - bw / 2, top, bw, bh)
              } else {
                ctx.fillStyle = col
                ctx.fillRect(x - bw / 2, top, bw, bh)
              }
              ctx.globalAlpha = 1
            }
          }
          ctx.fillStyle = 'rgba(224,166,63,0.9)'
          ctx.fillText('1M GHOST', 4, 14)
        }
      }

      // series
      if (chartType === 'candles') {
        vis.forEach((c, i) => {
          if (!c) return
          const x = xOf(i)
          const up = c.c >= c.o
          ctx.strokeStyle = up ? UP : DOWN
          ctx.fillStyle = up ? UP : DOWN
          ctx.beginPath()
          ctx.moveTo(x, yOf(c.h)); ctx.lineTo(x, yOf(c.l))
          ctx.stroke()
          const yO = yOf(c.o), yC = yOf(c.c)
          const top = Math.min(yO, yC)
          const bh = Math.max(1, Math.abs(yC - yO))
          ctx.fillRect(x - bodyW / 2, top, bodyW, bh)
        })
      } else {
        ctx.beginPath()
        let started = false
        vis.forEach((c, i) => {
          if (!c) return
          const x = xOf(i), y = yOf(c.c)
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        })
        ctx.strokeStyle = '#f5a623'
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.lineWidth = 1
        if (chartType === 'area' && started) {
          const lastReal = Math.min(slots - 1, data.length - 1 - start)
          const grad = ctx.createLinearGradient(0, 0, 0, priceH)
          grad.addColorStop(0, 'rgba(245,166,35,0.22)')
          grad.addColorStop(1, 'rgba(245,166,35,0)')
          ctx.lineTo(xOf(lastReal), priceH)
          ctx.lineTo(xOf(Math.max(0, data.length - 1 - start < slots ? data.length - 1 - start : 0)) || xOf(0), priceH)
          ctx.closePath()
          ctx.fillStyle = grad
          ctx.fill()
        }
      }

      // overlay indicator lines
      const drawSeries = (arr: (number | null)[], color: string, dash: number[] = []) => {
        ctx.setLineDash(dash)
        ctx.strokeStyle = color
        ctx.lineWidth = 1.1
        ctx.beginPath()
        let st = false
        for (let i = start; i < end; i++) {
          const v = arr[i]; if (v == null) { st = false; continue }
          const x = xOf(i - start), y = yOf(v)
          if (!st) { ctx.moveTo(x, y); st = true } else ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineWidth = 1
      }
      if (bb) {
        // band fill
        ctx.beginPath()
        let st = false
        for (let i = start; i < end; i++) {
          const v = bb.up[i]; if (v == null) { st = false; continue }
          const x = xOf(i - start), y = yOf(v)
          if (!st) { ctx.moveTo(x, y); st = true } else ctx.lineTo(x, y)
        }
        for (let i = end - 1; i >= start; i--) {
          const v = bb.lo[i]; if (v == null) continue
          ctx.lineTo(xOf(i - start), yOf(v))
        }
        ctx.closePath()
        ctx.fillStyle = 'rgba(139,148,158,0.07)'
        ctx.fill()
        drawSeries(bb.mid, 'rgba(139,148,158,0.7)', [4, 3])
        drawSeries(bb.up, 'rgba(139,148,158,0.4)')
        drawSeries(bb.lo, 'rgba(139,148,158,0.4)')
      }
      if (s20) drawSeries(s20, 'rgba(77,208,225,0.85)')
      if (s50) drawSeries(s50, 'rgba(180,140,232,0.85)')
      if (e9) drawSeries(e9, '#ffd166')
      if (e21) drawSeries(e21, '#e06c9f')
      if (vw) drawSeries(vw, 'rgba(77,208,225,0.75)', [5, 3])

      // markers (position avg prices)
      for (const m of markers) {
        const y = yOf(m.price)
        if (y < -8 || y > priceH + 8) continue
        ctx.setLineDash([4, 3])
        ctx.strokeStyle = m.color
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = m.color
        ctx.fillRect(plotW + 2, y - 7, axisW - 4, 14)
        ctx.fillStyle = '#0b0e11'
        ctx.textAlign = 'center'
        ctx.font = '9px ui-monospace, monospace'
        ctx.fillText(m.label, plotW + axisW / 2, y)
        ctx.font = '10px ui-monospace, monospace'
      }

      // last price line + axis tag
      const lastC = data[data.length - 1]
      {
        const y = yOf(lastC.c)
        if (y >= 0 && y <= priceH) {
          const up = lastC.c >= lastC.o
          ctx.setLineDash([2, 3])
          ctx.strokeStyle = up ? 'rgba(0,200,150,0.55)' : 'rgba(255,77,94,0.55)'
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = up ? UP : DOWN
          ctx.fillRect(plotW + 2, y - 8, axisW - 4, 16)
          ctx.fillStyle = '#0b0e11'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(lastC.c.toFixed(2), plotW + axisW / 2, y)
        }
      }

      // scales baseline — dashed amber line, draggable / set-by-click
      if (!mini && (secondaries.includes('pct') || secondaries.includes('inv') || secondaries.includes('pts') || primary !== 'price')) {
        const yBase = yOf(baseline)
        drawMetaRef.current = { yBase, baseline }
        if (yBase >= 0 && yBase <= priceH) {
          ctx.setLineDash([5, 4])
          ctx.strokeStyle = 'rgba(224,166,63,0.75)'
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.moveTo(colW, yBase); ctx.lineTo(plotW, yBase); ctx.stroke()
          ctx.setLineDash([])
          ctx.lineWidth = 1
          // zero anchors of the % / pts scales sit on the baseline
          ctx.fillStyle = 'rgba(224,166,63,0.9)'
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
          ctx.fillText(primary === 'price' ? '0%' : '0', plotW - 4, yBase - 6)
        }
      }

      // ---- legend: ALWAYS visible. Hovered candle wins over last. ----
      const drawLegend = (c: Candle, idxTime: number, livePct: number | null) => {
        const up = c.c >= c.o
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillStyle = '#e6e9ec'
        ctx.font = 'bold 10px ui-monospace, monospace'
        ctx.fillText(symbol, 6, 4)
        let x = 6 + ctx.measureText(symbol).width + 8
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillStyle = '#8b949e'
        ctx.fillText(`· ${tf} ·`, x, 4); x += ctx.measureText(`· ${tf} ·`).width + 6
        ctx.fillStyle = up ? UP : DOWN
        const ltpTxt = c.c.toFixed(2)
        ctx.fillText(ltpTxt, x, 4); x += ctx.measureText(ltpTxt).width + 8
        if (livePct != null) {
          ctx.fillStyle = livePct >= 0 ? UP : DOWN
          ctx.fillText(`${livePct >= 0 ? '+' : ''}${livePct.toFixed(2)}%`, x, 4); x += ctx.measureText(`${livePct >= 0 ? '+' : ''}${livePct.toFixed(2)}%`).width + 10
        }
        const parts: [string, number][] = [['O', c.o], ['H', c.h], ['L', c.l], ['C', c.c]]
        for (const [k, v] of parts) {
          ctx.fillStyle = '#8b949e'
          ctx.fillText(k, x, 4); x += 10
          ctx.fillStyle = up ? UP : DOWN
          ctx.fillText(v.toFixed(2), x, 4); x += ctx.measureText(v.toFixed(2)).width + 8
        }
        if (c.v > 0) {
          ctx.fillStyle = '#8b949e'
          ctx.fillText(`V ${fmtVol(c.v)}`, x, 4); x += ctx.measureText(`V ${fmtVol(c.v)}`).width + 8
        }
        ctx.fillStyle = '#56606b'
        ctx.fillText(fmtAxisTime(idxTime, tf), x, 4)
        // indicator readouts
        if (rsiArr) {
          const i = Math.max(0, Math.min(data.length - 1, Math.round((idxTime - data[0].t) / tfMs)))
          const v = rsiArr[i]
          if (v != null) { ctx.fillStyle = v > 70 ? DOWN : v < 30 ? UP : '#f5a623'; ctx.fillText(`RSI ${v.toFixed(1)}`, x, 4) }
        }
      }
      // focus candle: hovered > synced > last
      let focus: { c: Candle; t: number } | null = { c: lastC, t: lastT }
      const drawCrossAt = (slotIdx: number, own: boolean, syncPrice: number | null) => {
        if (slotIdx < 0 || slotIdx >= slots) return
        const x = xOf(slotIdx)
        ctx.strokeStyle = CROSS
        ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - axisH); ctx.stroke()
        if (own && crossRef.current) {
          const y = Math.min(priceH, Math.max(0, crossRef.current.y))
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
          const price = pMax - (crossRef.current.y / priceH) * (pMax - pMin)
          ctx.fillStyle = '#2a3441'
          ctx.fillRect(plotW + 2, y - 8, axisW - 4, 16)
          ctx.fillStyle = '#e6e9ec'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(price.toFixed(2), plotW + axisW / 2, y)
        }
        if (syncPrice != null && syncPrice >= pMin && syncPrice <= pMax) {
          const sy = yOf(syncPrice)
          ctx.strokeStyle = 'rgba(255,255,255,0.16)'
          ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(plotW, sy); ctx.stroke()
          ctx.fillStyle = '#2a3441'
          ctx.fillRect(plotW + 2, sy - 8, axisW - 4, 16)
          ctx.fillStyle = '#e6e9ec'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(syncPrice.toFixed(2), plotW + axisW / 2, sy)
        }
        ctx.setLineDash([])
        // time bubble
        const t = timeOfSlot(slotIdx)
        ctx.fillStyle = '#2a3441'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillRect(Math.min(plotW - 48, Math.max(0, x - 24)), h - axisH + 2, 48, 14)
        ctx.fillStyle = '#e6e9ec'
        ctx.fillText(fmtAxisTime(t, tf), Math.min(plotW - 24, Math.max(24, x)), h - axisH + 4)
        const c = vis[slotIdx]
        if (c) focus = { c, t }
      }

      // own crosshair
      if (!mini && crossRef.current && crossRef.current.x < plotW && crossRef.current.y < h - axisH) {
        const slotIdx = Math.min(slots - 1, Math.max(0, Math.floor(crossRef.current.x / cw)))
        drawCrossAt(slotIdx, true, null)
      }
      // synced crosshair from another chart (same interval)
      const sc = syncCrossRef.current
      if (!mini && sc) {
        // sc.slot carries the candle TIME (set by the sync bus)
        const slot0 = timeOfSlot(0)
        const slotIdx = Math.round((sc.slot - slot0) / tfMs)
        drawCrossAt(slotIdx, false, sc.price)
      }

      // day change reference for the legend %
      const fc = focus as { c: Candle; t: number } | null
      if (fc) {
        const pct = dayRef ? ((fc.c.c - dayRef) / dayRef) * 100 : null
        drawLegend(fc.c, fc.t, pct)
      }
    }

    const loop = () => { draw(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    const ro = new ResizeObserver(() => forceRender(n => n + 1))
    ro.observe(wrap)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [candles, ghost, barCount, chartType, showVolume, showSMA20, showSMA50, showEMA, showVWAP, showBOLL, showRSI, showMACD, showGhost, ghostStyle, scales, markers, symbol, tf, loading, err, mini])

  // ---- interactions ----
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const win = winRef.current
    const f = e.deltaY > 0 ? 1.15 : 0.87
    if ((win.plotW > 0 && x >= win.plotW) || e.shiftKey) {
      priceZoomRef.current = Math.max(0.15, Math.min(10, priceZoomRef.current * f))
    } else {
      setBarCount(b => Math.max(25, Math.min(900, Math.round(b * f))))
    }
    setDirty(true)
  }
  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const win = winRef.current
    // baseline drag zone (scales % / pts enabled): grab within 5px of the line
    const sc = scales
    const baselineEnabled = sc && (sc.pct || sc.inv || sc.pts) && !mini
    if (baselineEnabled && x < win.plotW && y <= win.priceH) {
      const meta = drawMetaRef.current
      if (meta.yBase >= 0 && Math.abs(y - meta.yBase) <= 5) {
        baseRef.current = meta.baseline // freeze the (possibly default) baseline
        dragRef.current = { zone: 'base', startX: e.clientX, startY: e.clientY, startOffset: 0, startPriceOff: 0, startPriceZoom: 1, pxPerPx: (win.pMax - win.pMin) / (win.priceH || 1), moved: 0 }
        return
      }
    }
    const zone: DragState['zone'] = x >= win.plotW ? 'price' : y >= win.h - win.axisH ? 'time' : 'plot'
    dragRef.current = {
      zone,
      startX: e.clientX,
      startY: e.clientY,
      startOffset: offsetRef.current,
      startPriceOff: priceOffRef.current,
      startPriceZoom: priceZoomRef.current,
      pxPerPx: win.priceH > 0 ? (win.pMax - win.pMin) / win.priceH : 1,
      moved: 0,
    }
  }
  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    crossRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const win = winRef.current
    // publish to the sync bus (same-interval charts follow)
    if (win.plotW > 0 && candles.length > 1) {
      const tfMs = TF_MS[tf as keyof typeof TF_MS] ?? 60_000
      const end = candles.length - Math.round(offsetRef.current)
      const start = Math.min(end - barCount, candles.length - 2)
      const cw = win.plotW / (end - start)
      const slotIdx = Math.floor((e.clientX - rect.left) / cw)
      const di = start + slotIdx
      const lastT = candles[candles.length - 1].t
      const t = di < candles.length ? candles[di].t : lastT + (di - (candles.length - 1)) * tfMs
      const price = e.clientY - rect.top <= win.priceH
        ? win.pMax - ((e.clientY - rect.top) / win.priceH) * (win.pMax - win.pMin)
        : null
      emitCross({ src: chartId.current, tf, t, price })
    }
    const d = dragRef.current
    if (!d) return
    d.moved = Math.max(d.moved, Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY))
    if (d.zone === 'base') {
      // drag the baseline — % and pts scales follow ("rearrange")
      const y = Math.min(win.priceH, Math.max(0, e.clientY - rect.top))
      baseRef.current = Number((win.pMax - (y / (win.priceH || 1)) * (win.pMax - win.pMin)).toFixed(2))
      return
    }
    if (d.zone === 'price') {
      const f = Math.exp((d.startY - e.clientY) / 180)
      priceZoomRef.current = Math.max(0.15, Math.min(10, d.startPriceZoom * f))
      return
    }
    // horizontal pan — negative offset = future space
    const cwAvg = Math.max(0.5, (sizeRef.current.w - (mini ? 46 : 58)) / barCount)
    const barsMoved = Math.round((e.clientX - d.startX) / cwAvg)
    const maxOff = candles.length - 25
    offsetRef.current = Math.max(-FUTURE_BARS, Math.min(maxOff, d.startOffset + barsMoved))
    if (d.zone === 'plot') {
      priceOffRef.current = d.startPriceOff + (e.clientY - d.startY) * d.pxPerPx
    }
    setDirty(true)
  }
  const onMouseUp = (e: React.MouseEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || d.moved >= 4) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const win = winRef.current
    if (x < win.plotW && y < win.priceH && win.pMax > win.pMin) {
      const price = Number((win.pMax - (y / win.priceH) * (win.pMax - win.pMin)).toFixed(2))
      // scales baseline pick mode — consumed by the first chart clicked
      if (pickRef.current) {
        baseRef.current = price
        pickRef.current = false
        setBaseArmed(false)
        window.dispatchEvent(new Event(BASE_SET_EVENT))
        return
      }
      onPriceClick?.(price)
    }
  }
  const onMouseLeave = () => {
    crossRef.current = null
    dragRef.current = null
    emitCross({ src: chartId.current, tf, t: null, price: null })
  }
  const resetView = () => {
    offsetRef.current = 0
    priceZoomRef.current = 1
    priceOffRef.current = 0
    baseRef.current = null // baseline returns to the day-open ref
    setBarCount(mini ? 60 : 120)
    setDirty(false)
  }

  return (
    <div ref={wrapRef} className={`relative w-full ${height} select-none`} data-chart-root>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onDoubleClick={resetView}
      />
      <div className="absolute right-16 top-1.5 flex gap-2 text-[9px] text-muted-foreground pointer-events-none">
        {showSMA20 && <span className="text-[#4dd0e1]">SMA20</span>}
        {showSMA50 && <span className="text-[#b48ce8]">SMA50</span>}
        {showEMA && <span className="text-[#ffd166]">EMA9/21</span>}
        {showVWAP && <span className="text-[#4dd0e1]">VWAP</span>}
        {showBOLL && <span className="text-muted-foreground">BB</span>}
        {showGhost && tf !== '1m' && <span className="text-[#e0a63f]">1M GHOST</span>}
      </div>
      {baseArmed && (
        <div className="absolute left-1/2 top-1.5 -translate-x-1/2 px-2 py-0.5 rounded bg-[#e0a63f] text-black text-[9px] font-bold pointer-events-none">
          click the chart to set the scales baseline
        </div>
      )}
      {!dirty && !mini && (
        <div className="absolute bottom-6 right-14 text-[9px] text-muted-foreground/60 pointer-events-none flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[#00c896] pulse-dot" /> LIVE
        </div>
      )}
      {dirty && (
        <button
          onClick={resetView}
          title="Reset chart to live price action (latest bar)"
          className="absolute bottom-6 right-14 px-1.5 py-0.5 rounded bg-primary/80 text-primary-foreground text-[9px] font-bold hover:bg-primary shadow flex items-center gap-1"
        >
          <span className="text-[8px]">▶</span> LIVE
        </button>
      )}
    </div>
  )
}
