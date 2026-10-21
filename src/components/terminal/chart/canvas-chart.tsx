'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { Candle, Tick } from '@/lib/types'
import { TF_MS } from '@/lib/types'
import { api } from '../lib/client-api'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'

// ============================================================
// From-scratch canvas candlestick chart — no charting library.
// Candles / line / area + volume histogram, crosshair with
// OHLCV legend, price/time axes, independent axis zoom + pan:
//   · wheel on plot / time axis  -> time zoom (bars)
//   · wheel on price axis / +Shift -> price-scale-only zoom
//   · drag plot                   -> free pan (left/right/top/bottom)
//   · drag price axis             -> squeeze/stretch price scale
//   · drag time axis              -> pan time
//   · double-click                -> reset view
// SMA overlays, live tick streaming, position avg-price markers,
// last-price label, click-to-set-limit.
// ============================================================

export interface ChartMarker { price: number; label: string; color: string }

interface Props {
  symbol: string
  tf: string
  chartType: 'candles' | 'line' | 'area'
  showVolume: boolean
  showSMA20: boolean
  showSMA50: boolean
  markers?: ChartMarker[]
  onPriceClick?: (price: number) => void
  height: string
  mini?: boolean // compact mode (option panes): thinner axes, no crosshair legend/time axis
}

const UP = '#00c896'
const DOWN = '#ff4d5e'
const GRID = 'rgba(255,255,255,0.045)'
const AXIS_TXT = '#8b949e'
const CROSS = 'rgba(255,255,255,0.25)'

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

interface DragState {
  zone: 'plot' | 'price' | 'time'
  startX: number
  startY: number
  startOffset: number
  startPriceOff: number
  startPriceZoom: number
  pxPerPx: number // price units per vertical pixel at drag start
  moved: number
}

export function CanvasChart({ symbol, tf, chartType, showVolume, showSMA20, showSMA50, markers = [], onPriceClick, height, mini = false }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [barCount, setBarCount] = useState(mini ? 60 : 120)
  const offsetRef = useRef(0) // time pan (bars from the right edge)
  const priceZoomRef = useRef(1) // 1 = fit data; >1 zoomed out, <1 zoomed in
  const priceOffRef = useRef(0) // free vertical pan (price units)
  const [, forceRender] = useState(0)
  const crossRef = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const sizeRef = useRef({ w: 0, h: 0 })
  // last drawn window — lets event handlers hit-test axes and map px->price accurately
  const winRef = useRef({ w: 0, h: 0, plotW: 0, priceH: 0, axisH: mini ? 12 : 20, pMin: 0, pMax: 1 })
  const lastVolRef = useRef<Record<string, number>>({})

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
    load()
    subscribeTicks([symbol])
    const iv = setInterval(load, 30_000) // periodic authoritative resync
    return () => {
      unsubscribeTicks([symbol])
      clearInterval(iv)
    }
  }, [symbol, tf, load])

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
    })
  }, [symbol, tf])

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
      const volH = showVolume ? Math.round((h - axisH) * (mini ? 0.14 : 0.18)) : 0
      const priceH = h - axisH - volH - (showVolume ? 5 : 0)

      // visible window
      const end = Math.max(2, data.length - offsetRef.current)
      const start = Math.max(0, end - barCount)
      const vis = data.slice(start, end)
      if (vis.length < 2) {
        offsetRef.current = Math.max(0, data.length - 2 - barCount)
        return
      }

      let pMin = Infinity, pMax = -Infinity
      for (const c of vis) { if (c.l < pMin) pMin = c.l; if (c.h > pMax) pMax = c.h }
      // include overlays
      const s20 = showSMA20 ? sma(data, 20) : null
      const s50 = showSMA50 ? sma(data, 50) : null
      if (s20) for (let i = start; i < end; i++) { const v = s20[i]; if (v != null) { if (v < pMin) pMin = v; if (v > pMax) pMax = v } }
      if (s50) for (let i = start; i < end; i++) { const v = s50[i]; if (v != null) { if (v < pMin) pMin = v; if (v > pMax) pMax = v } }
      for (const m of markers) { if (m.price < pMin) pMin = m.price; if (m.price > pMax) pMax = m.price }
      const pad = (pMax - pMin) * 0.08 || pMax * 0.001 || 1
      pMin -= pad; pMax += pad

      // price-scale zoom (around window centre) + free vertical pan
      const zoom = priceZoomRef.current
      const center = (pMin + pMax) / 2
      const half = ((pMax - pMin) / 2) * zoom
      pMin = center - half + priceOffRef.current
      pMax = center + half + priceOffRef.current

      winRef.current = { w, h, plotW, priceH, axisH, pMin, pMax }

      const cw = plotW / vis.length // candle slot width
      const bodyW = Math.max(1, Math.min(14, cw * 0.68))
      const xOf = (i: number) => i * cw + cw / 2
      const yOf = (p: number) => ((pMax - p) / (pMax - pMin)) * priceH

      // grid + price axis
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      for (const p of niceTicks(pMin, pMax, Math.max(mini ? 2 : 3, Math.floor(priceH / (mini ? 90 : 55))))) {
        const y = yOf(p)
        ctx.strokeStyle = GRID
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
        ctx.fillStyle = AXIS_TXT
        ctx.fillText(p >= 1000 ? p.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : p.toFixed(2), plotW + 6, y)
      }

      // time axis (skipped in mini mode — too cramped)
      if (!mini) {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      const labelEvery = Math.max(1, Math.ceil(vis.length / Math.max(2, Math.floor(plotW / 90))))
      vis.forEach((c, i) => {
        if (i % labelEvery !== 0) return
        const x = xOf(i)
        ctx.strokeStyle = GRID
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - axisH); ctx.stroke()
        ctx.fillStyle = AXIS_TXT
        ctx.fillText(fmtAxisTime(c.t, tf), x, h - axisH + 4)
      })
      }

      // volume histogram
      if (showVolume && volH > 0) {
        let vMax = 0
        for (const c of vis) if (c.v > vMax) vMax = c.v
        const vy0 = priceH + 5 + volH
        vis.forEach((c, i) => {
          if (c.v <= 0) return
          const vh = (c.v / vMax) * volH
          ctx.fillStyle = c.c >= c.o ? 'rgba(0,200,150,0.35)' : 'rgba(255,77,94,0.35)'
          ctx.fillRect(xOf(i) - bodyW / 2, vy0 - vh, bodyW, vh)
        })
        ctx.fillStyle = 'rgba(139,148,158,0.8)'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(`Vol ${fmtVol(vMax)}`, 4, vy0 - volH + 1)
      }

      // series
      if (chartType === 'candles') {
        vis.forEach((c, i) => {
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
        // line / area
        ctx.beginPath()
        vis.forEach((c, i) => {
          const x = xOf(i), y = yOf(c.c)
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        })
        ctx.strokeStyle = '#f5a623'
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.lineWidth = 1
        if (chartType === 'area') {
          const grad = ctx.createLinearGradient(0, 0, 0, priceH)
          grad.addColorStop(0, 'rgba(245,166,35,0.22)')
          grad.addColorStop(1, 'rgba(245,166,35,0)')
          ctx.lineTo(xOf(vis.length - 1), priceH)
          ctx.lineTo(xOf(0), priceH)
          ctx.closePath()
          ctx.fillStyle = grad
          ctx.fill()
        }
      }

      // SMA overlays
      const drawSma = (arr: (number | null)[], color: string) => {
        ctx.beginPath()
        let started = false
        for (let i = start; i < end; i++) {
          const v = arr[i]
          if (v == null) { started = false; continue }
          const x = xOf(i - start), y = yOf(v)
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = color
        ctx.stroke()
      }
      if (s20) drawSma(s20, 'rgba(77,208,225,0.85)')
      if (s50) drawSma(s50, 'rgba(180,140,232,0.85)')

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

      // last price line
      const lastC = data[data.length - 1 - offsetRef.current] ?? vis[vis.length - 1]
      if (lastC) {
        const y = yOf(lastC.c)
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

      // crosshair (disabled in mini mode)
      const cross = mini ? null : crossRef.current
      if (cross && cross.x < plotW && cross.y < h - axisH) {
        ctx.strokeStyle = CROSS
        ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.moveTo(cross.x, 0); ctx.lineTo(cross.x, h - axisH); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(0, cross.y); ctx.lineTo(plotW, cross.y); ctx.stroke()
        ctx.setLineDash([])

        // hovered candle legend
        const idx = Math.min(vis.length - 1, Math.max(0, Math.floor(cross.x / cw)))
        const c = vis[idx]
        const up = c.c >= c.o
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillStyle = '#8b949e'
        ctx.fillText(`${symbol} · ${tf}`, 6, 4)
        const parts = [
          ['O', c.o], ['H', c.h], ['L', c.l], ['C', c.c],
        ] as [string, number][]
        let x = 6 + ctx.measureText(`${symbol} · ${tf}`).width + 14
        for (const [k, v] of parts) {
          ctx.fillStyle = '#8b949e'
          ctx.fillText(k, x, 4); x += 10
          ctx.fillStyle = up ? UP : DOWN
          ctx.fillText(v.toFixed(2), x, 4); x += ctx.measureText(v.toFixed(2)).width + 10
        }
        if (c.v > 0) {
          ctx.fillStyle = '#8b949e'
          ctx.fillText(`Vol ${c.v.toLocaleString('en-IN')}`, x, 4)
        }
        // price bubble
        const price = pMax - (cross.y / priceH) * (pMax - pMin)
        ctx.fillStyle = '#2a3441'
        ctx.fillRect(plotW + 2, cross.y - 8, axisW - 4, 16)
        ctx.fillStyle = '#e6e9ec'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(price.toFixed(2), plotW + axisW / 2, cross.y)
        // time bubble
        ctx.fillStyle = '#2a3441'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const tb = fmtAxisTime(c.t, tf)
        ctx.fillRect(cross.x - 24, h - axisH + 2, 48, 14)
        ctx.fillStyle = '#e6e9ec'
        ctx.fillText(tb, cross.x, h - axisH + 4)
      }
    }

    const loop = () => { draw(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    const ro = new ResizeObserver(() => forceRender(n => n + 1))
    ro.observe(wrap)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [candles, barCount, chartType, showVolume, showSMA20, showSMA50, markers, symbol, tf, loading, err, mini])

  // ---- interactions ----
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const win = winRef.current
    const f = e.deltaY > 0 ? 1.15 : 0.87
    if ((win.plotW > 0 && x >= win.plotW) || e.shiftKey) {
      // price-scale-only zoom (wheel over the price axis, or Shift+wheel anywhere)
      priceZoomRef.current = Math.max(0.15, Math.min(10, priceZoomRef.current * f))
    } else {
      // time zoom (bars visible)
      setBarCount(b => Math.max(25, Math.min(900, Math.round(b * f))))
    }
  }
  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const win = winRef.current
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
    const d = dragRef.current
    if (!d) return
    d.moved = Math.max(d.moved, Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY))
    if (d.zone === 'price') {
      // drag up on the price axis = zoom in (compress), down = zoom out (stretch)
      const f = Math.exp((d.startY - e.clientY) / 180)
      priceZoomRef.current = Math.max(0.15, Math.min(10, d.startPriceZoom * f))
      return
    }
    // plot / time axis: horizontal pan (time)
    const dataLen = candles.length
    const cwAvg = Math.max(0.5, (sizeRef.current.w - (mini ? 46 : 58)) / barCount)
    const barsMoved = Math.round((e.clientX - d.startX) / cwAvg)
    offsetRef.current = Math.max(0, Math.min(dataLen - 25, d.startOffset + barsMoved))
    // plot only: free vertical pan (price follows the cursor)
    if (d.zone === 'plot') {
      priceOffRef.current = d.startPriceOff + (e.clientY - d.startY) * d.pxPerPx
    }
  }
  const onMouseUp = (e: React.MouseEvent) => {
    const d = dragRef.current
    dragRef.current = null
    // click without drag -> price click (sync limit price to order pad)
    if (!d || d.moved >= 4 || !onPriceClick) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const win = winRef.current
    if (x < win.plotW && y < win.priceH && win.pMax > win.pMin) {
      const price = win.pMax - (y / win.priceH) * (win.pMax - win.pMin)
      onPriceClick(Number(price.toFixed(2)))
    }
  }
  const onMouseLeave = () => { crossRef.current = null; dragRef.current = null }
  const resetView = () => {
    offsetRef.current = 0
    priceZoomRef.current = 1
    priceOffRef.current = 0
    setBarCount(mini ? 60 : 120)
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
      </div>
    </div>
  )
}
