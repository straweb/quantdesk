'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { Candle, Tick } from '@/lib/types'
import { TF_MS } from '@/lib/types'
import { api } from '../lib/client-api'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'

// ============================================================
// From-scratch canvas candlestick chart — no charting library.
// Candles / line / area + volume histogram, crosshair with
// OHLCV legend, price/time axes, wheel zoom (around cursor),
// drag pan, SMA overlays, live tick streaming, position
// average-price lines, last-price pulse label.
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
  mini?: boolean // compact mode (ATM option mini charts): thinner axes, no crosshair legend/time axis
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

export function CanvasChart({ symbol, tf, chartType, showVolume, showSMA20, showSMA50, markers = [], onPriceClick, height, mini = false }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [barCount, setBarCount] = useState(mini ? 60 : 120)
  const offsetRef = useRef(0)
  const [, forceRender] = useState(0)
  const crossRef = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null)
  const sizeRef = useRef({ w: 0, h: 0 })
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
      const volH = showVolume && !mini ? Math.round((h - axisH) * 0.18) : 0
      const priceH = h - axisH - volH - (showVolume && !mini ? 6 : 0)

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

      // volume
      if (showVolume && !mini && volH > 0) {
        let vMax = 0
        for (const c of vis) if (c.v > vMax) vMax = c.v
        const vy0 = priceH + 6 + volH
        vis.forEach((c, i) => {
          if (c.v <= 0) return
          const vh = (c.v / vMax) * volH
          ctx.fillStyle = c.c >= c.o ? 'rgba(0,200,150,0.35)' : 'rgba(255,77,94,0.35)'
          ctx.fillRect(xOf(i) - bodyW / 2, vy0 - vh, bodyW, vh)
        })
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
  }, [candles, barCount, chartType, showVolume, showSMA20, showSMA50, markers, symbol, tf, loading, err])

  // ---- interactions ----
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 1.15 : 0.87
    setBarCount(b => Math.max(25, Math.min(900, Math.round(b * factor))))
  }
  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startOffset: offsetRef.current }
  }
  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    crossRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    if (dragRef.current) {
      const dataLen = candles.length
      const cwAvg = (sizeRef.current.w - 58) / barCount
      const barsMoved = Math.round((e.clientX - dragRef.current.startX) / cwAvg)
      offsetRef.current = Math.max(0, Math.min(dataLen - 25, dragRef.current.startOffset + barsMoved))
    }
  }
  const onMouseUp = (e: React.MouseEvent) => {
    // click without drag -> price click (sync limit price to order pad)
    if (mini) { dragRef.current = null; return }
    const moved = dragRef.current ? Math.abs(e.clientX - dragRef.current.startX) : 99
    if (moved < 4 && onPriceClick) {
      const rect = canvasRef.current!.getBoundingClientRect()
      const y = e.clientY - rect.top
      const priceH = sizeRef.current.h - 20
      const data = candles
      if (data.length >= 2 && y < priceH) {
        const end = Math.max(2, data.length - offsetRef.current)
        const start = Math.max(0, end - barCount)
        const vis = data.slice(start, end)
        let pMin = Infinity, pMax = -Infinity
        for (const c of vis) { if (c.l < pMin) pMin = c.l; if (c.h > pMax) pMax = c.h }
        const pad = (pMax - pMin) * 0.08 || 1
        pMin -= pad; pMax += pad
        const price = pMax - (y / priceH) * (pMax - pMin)
        onPriceClick(Number(price.toFixed(2)))
      }
    }
    dragRef.current = null
  }
  const onMouseLeave = () => { crossRef.current = null; dragRef.current = null }

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
        onDoubleClick={() => { offsetRef.current = 0; setBarCount(120) }}
      />
      <div className="absolute right-16 top-1.5 flex gap-2 text-[9px] text-muted-foreground pointer-events-none">
        {showSMA20 && <span className="text-[#4dd0e1]">SMA20</span>}
        {showSMA50 && <span className="text-[#b48ce8]">SMA50</span>}
      </div>
    </div>
  )
}
