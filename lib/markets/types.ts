/** Shapes shared by the market-data providers, the API route and the UI. Display data only: never used to size an order. */

export type Segment = 'us' | 'global' | 'crypto' | 'metals'

export const SEGMENT_ORDER: Segment[] = ['us', 'global', 'crypto', 'metals']

export const SEGMENT_META: Record<Segment, { label: string; description: string }> = {
  us: { label: 'US markets', description: 'US equity indices and volatility' },
  global: { label: 'Global markets', description: 'Major indices in Europe and Asia' },
  crypto: { label: 'Crypto', description: 'Spot prices on Coinbase' },
  metals: { label: 'Gold and silver', description: 'Precious metals futures and tokenized gold' },
}

export type MarketSource = 'coinbase' | 'coinbase-derivatives' | 'yahoo'

export type MarketState = 'open' | 'closed' | 'unknown'

export interface Quote {
  /** Stable id used across the app, e.g. "spx" or "btc". */
  id: string
  /** The venue's own ticker, shown as written: "^GSPC", "BTC-USD", "GC=F". */
  symbol: string
  name: string
  segment: Segment | 'macro'
  price: number | null
  previousClose: number | null
  change: number | null
  changePercent: number | null
  currency: string
  /** When the venue last updated the price (ISO 8601). */
  asOf: string | null
  marketState: MarketState
  source: MarketSource
  /** True when the venue may publish this price with a delay. */
  delayed: boolean
  /** Recent prices, oldest first, for a sparkline. May be empty. */
  spark: number[]
  /** True for Coinbase spot products the agent may trade. */
  tradable: boolean
  /** Decimal places to show. */
  decimals: number
  /** Set when the price could not be loaded; `price` is then null. */
  error?: string
}

export interface SourceHealth {
  source: MarketSource
  ok: boolean
  latencyMs: number
  error?: string
}

export interface MarketSnapshot {
  segments: Record<Segment, Quote[]>
  /** Dollar index, 10-year yield, crude: context for the AI desk, not a display segment. */
  macro: Quote[]
  generatedAt: string
  sources: SourceHealth[]
}

/** One day of history. Times are unix seconds, oldest first. */
export interface DailySeries {
  id: string
  symbol: string
  t: number[]
  c: number[]
}
