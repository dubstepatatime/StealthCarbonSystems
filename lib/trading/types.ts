/**
 * Domain types for the trading agent. Pure data; no I/O.
 *
 * Pipeline, in order, for one agent "tick":
 *
 *   market data ──> signals (quant, optionally tilted by the AI desk)
 *                └─> allocator (target weights) ──> rebalance intents
 *                                                └─> risk engine (approve / clamp / reject)
 *                                                    └─> broker (paper or Coinbase)
 *
 * The model never produces an order. It produces a bounded view per asset; the
 * allocator and the risk engine are deterministic and have the last word.
 */
import type { Big } from './money'

export type Side = 'BUY' | 'SELL'

/** `paper` simulates fills; `approval` needs the user's OK per order; `auto` trades live inside the limits. */
export type AgentMode = 'paper' | 'approval' | 'auto'

/** `halted` means a circuit breaker tripped and a person must resume it. */
export type AgentStatus = 'active' | 'paused' | 'halted'

export type Ledger = 'paper' | 'live'

export type RiskProfile = 'conservative' | 'balanced' | 'growth'

export type Regime = 'risk_on' | 'neutral' | 'risk_off'

export type SignalWord = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

/** The user's limits for their agent. Every field is clamped to PLATFORM_LIMITS on save. */
export interface RiskPolicy {
  /** Capital the agent may deploy, in USD. It never spends more than this plus its own proceeds. */
  capitalUsd: string
  /** Most of the agent's equity that may sit outside cash, 0-100. */
  maxExposurePct: number
  /** Most of the agent's equity in any one asset, 0-100. */
  maxPositionPct: number
  /** Largest single order, in USD. */
  maxOrderUsd: string
  /** Smallest order worth sending, in USD (also bounded by the exchange minimum). */
  minOrderUsd: string
  /** Orders per UTC day that add risk. Exits are never blocked by this. */
  maxTradesPerDay: number
  /** Buy turnover per UTC day, in USD. */
  maxDailyTurnoverUsd: string
  /** Halt when the day's loss reaches this share of the day's opening equity, 0-100. */
  dailyLossLimitPct: number
  /** Halt when equity falls this far below its peak, 0-100. */
  maxDrawdownPct: number
  /** Do not trade unless a position is at least this far from target, in % of equity. */
  rebalanceBandPct: number
  /** Minutes between buys of the same product. */
  cooldownMinutes: number
  /** How far past the quote a limit order may be priced, in basis points. */
  maxSlippageBps: number
  /** Products the agent may trade. Must be a subset of the platform allow-list. */
  universe: string[]
}

/** What the exchange says about a product. All sizes are decimal strings. */
export interface ProductSpec {
  productId: string
  baseCurrency: string
  quoteCurrency: string
  baseIncrement: string
  quoteIncrement: string
  priceIncrement: string
  baseMinSize: string
  quoteMinSize: string
  /** True only for a spot product that is online and accepting ordinary orders. */
  tradable: boolean
  /** Why it is not tradable, when it is not. */
  untradableReason?: string
}

export interface TopOfBook {
  bid: Big
  ask: Big
  /** When the quote was observed. */
  asOf: Date
  /** 24-hour change in percent, when the venue reports it. */
  change24hPct: number | null
}

export interface Position {
  qty: Big
  /** Total cost of the open quantity, fees included, in USD. */
  costUsd: Big
}

/** The agent's own book. It only ever sells what this says it bought. */
export interface AgentPortfolio {
  cashUsd: Big
  positions: Record<string, Position>
}

/** One asset's signal for a tick. Scores live in [-1, 1]. */
export interface AssetSignal {
  productId: string
  /** Deterministic trend + momentum score. */
  quantScore: number
  /** The AI desk's view, or null when the desk did not run. */
  aiView: number | null
  /** What the allocator uses: the quant score tilted by a bounded amount of the AI view. */
  conviction: number
  word: SignalWord
  rationale: string
}

/** What the allocator proposes. Not yet an order. */
export interface TradeIntent {
  productId: string
  side: Side
  /** Desired trade size in USD at the mid price. */
  notionalUsd: Big
  /** Set for a full exit so the whole position is sold rather than a USD amount. */
  closePosition?: boolean
  reason: string
  targetWeight: number
  currentWeight: number
}

export type RiskCheckCode =
  | 'KILL_SWITCH'
  | 'AGENT_STATUS'
  | 'LIVE_PREREQUISITES'
  | 'PRODUCT_ALLOWED'
  | 'PRODUCT_TRADABLE'
  | 'QUOTE_FRESH'
  | 'QUOTE_SANE'
  | 'SIGNAL_FRESH'
  | 'VOLATILITY_HALT'
  | 'DAILY_TRADE_COUNT'
  | 'DAILY_TURNOVER'
  | 'COOLDOWN'
  | 'ORDER_SIZE_MAX'
  | 'POSITION_LIMIT'
  | 'EXPOSURE_LIMIT'
  | 'CASH_AVAILABLE'
  | 'POSITION_AVAILABLE'
  | 'EXCHANGE_BALANCE'
  | 'ORDER_SIZE_MIN'
  | 'PRICE_COLLAR'

export interface RiskCheck {
  code: RiskCheckCode
  /** `adjusted` means the order was made smaller to fit the limit. */
  outcome: 'pass' | 'adjusted' | 'fail'
  message: string
}

/** A fully specified limit order that passed every check. */
export interface OrderTicket {
  productId: string
  side: Side
  /** Quantity of the base asset, on the product's base increment. */
  baseSize: string
  /** Limit price, on the product's price increment. */
  limitPrice: string
  /** Exactly baseSize x limitPrice: the most a buy can cost, or the least a sell can raise, before fees. */
  notionalUsd: string
}

export interface RiskDecision {
  approved: boolean
  ticket: OrderTicket | null
  checks: RiskCheck[]
}

export type HaltReason = 'DAILY_LOSS_LIMIT' | 'MAX_DRAWDOWN'

export interface Fill {
  baseSize: Big
  /** Average execution price. */
  price: Big
  /** Quote amount exchanged, before fees. */
  quoteUsd: Big
  feeUsd: Big
}

export type OrderStatus =
  | 'awaiting_approval'
  | 'rejected'
  | 'expired'
  | 'submitted'
  | 'filled'
  | 'partially_filled'
  | 'cancelled'
  | 'failed'
