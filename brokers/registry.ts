import type { BrokerType, OrderLegResult, PlaceOrderRequest } from '../src/lib/types'
import { decryptJson } from '../src/lib/crypto'

// ============================================================
// Broker plugin registry — every broker lives in its own folder
// (OpenAlgo style) and implements BrokerAdapter. The order router
// fans a master order out to N enabled accounts across brokers.
// ============================================================

export interface SymbolMapInfo {
  masterSymbol: string
  exchange: string
  instrumentType: string // INDEX | EQ | FUT | CE | PE
  lotSize: number
  brokerSymbol: string
  brokerToken?: string
}

export interface LegContext {
  accountId: string
  accountLabel: string
  brokerType: BrokerType
  credentials: Record<string, string> | null
  order: {
    side: 'BUY' | 'SELL'
    qty: number // lots
    orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
    productType: 'MIS' | 'CNC' | 'NRML'
    limitPrice?: number
    triggerPrice?: number
    masterOrderId: string
    strategyId?: string
    source: string
  }
  symbolMap: SymbolMapInfo
  ltp: number
}

export interface BrokerAdapter {
  brokerType: BrokerType
  /** True when the adapter can reach its real REST endpoints; false => sandbox execution */
  isLiveCapable(): boolean
  /** Resolve broker-specific symbol/token from canonical master info (called at sync time) */
  mapSymbol(master: { symbol: string; exchange: string; instrumentType: string; expiry?: string | null; strike?: number | null; optionType?: string | null }): { brokerSymbol: string; brokerToken: string }
  placeOrder(ctx: LegContext): Promise<OrderLegResult>
  cancelOrder(ctx: LegContext, brokerOrderId: string): Promise<{ ok: boolean; message?: string }>
  /** Human readable name of the mode the adapter will operate in */
  modeLabel(creds: Record<string, string> | null): string
}

// Simple credential helper shared by adapters
export function credsFor(encrypted: string | null | undefined): Record<string, string> | null {
  return decryptJson(encrypted)
}

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
}

export const adapters: Partial<Record<BrokerType, BrokerAdapter>> = {}

export function registerAdapter(a: BrokerAdapter) {
  adapters[a.brokerType] = a
}

export function getAdapter(brokerType: BrokerType): BrokerAdapter | undefined {
  return adapters[brokerType]
}
