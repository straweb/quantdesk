'use client'

import { io, type Socket } from 'socket.io-client'
import type { Tick } from '@/lib/types'

// Singleton socket.io client for the market feed mini-service.
// Browser always connects through the Caddy gateway via XTransformPort.

type TickListener = (ticks: Record<string, Tick>) => void

const g = globalThis as unknown as {
  __ztermSocket: Socket | null
  __ztermListeners: Set<TickListener>
  __ztermSubs: Set<string>
  __ztermStatus: Set<(up: boolean) => void>
}

if (!g.__ztermSocket) {
  g.__ztermSocket = null
  g.__ztermListeners = new Set()
  g.__ztermSubs = new Set()
  g.__ztermStatus = new Set()
}

export function onTicks(fn: TickListener): () => void {
  g.__ztermListeners.add(fn)
  return () => g.__ztermListeners.delete(fn)
}

export function onFeedStatus(fn: (up: boolean) => void): () => void {
  g.__ztermStatus.add(fn)
  fn(!!g.__ztermSocket?.connected)
  return () => g.__ztermStatus.delete(fn)
}

export function subscribeTicks(symbols: string[]) {
  const added = symbols.filter(s => !g.__ztermSubs.has(s))
  added.forEach(s => g.__ztermSubs.add(s))
  g.__ztermSocket?.emit('subscribe', added)
}

export function unsubscribeTicks(symbols: string[]) {
  symbols.forEach(s => g.__ztermSubs.delete(s))
  g.__ztermSocket?.emit('unsubscribe', symbols)
}

export function ensureSocket(): Socket {
  if (g.__ztermSocket?.connected) return g.__ztermSocket
  if (g.__ztermSocket) return g.__ztermSocket

  const socket = io('/?XTransformPort=3003', {
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1500,
    timeout: 10000,
  })

  socket.on('connect', () => {
    // resubscribe everything after (re)connect
    if (g.__ztermSubs.size) socket.emit('subscribe', [...g.__ztermSubs])
    g.__ztermStatus.forEach(fn => fn(true))
  })
  socket.on('disconnect', () => g.__ztermStatus.forEach(fn => fn(false)))
  socket.on('connect_error', () => g.__ztermStatus.forEach(fn => fn(false)))

  socket.on('ticks', (batch: Tick[]) => {
    const map: Record<string, Tick> = {}
    for (const t of batch || []) map[t.symbol] = t
    g.__ztermListeners.forEach(fn => fn(map))
  })

  g.__ztermSocket = socket
  return socket
}
