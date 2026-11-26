/**
 * Allocator: convictions -> target weights -> rebalance intents.
 *
 * Long-only, spot-only, cash is the default. Deterministic: the same inputs
 * always give the same intents, so every trade can be replayed and explained.
 */
import { dec, toNumber, ZERO, type Big } from './money'
import { REGIME_EXPOSURE_SCALE } from './signals'
import type { AgentPortfolio, Regime, RiskPolicy, TradeIntent } from './types'

/** Conviction needed to open or add to a position. */
export const ENTRY_THRESHOLD = 0.1

export interface TargetInputs {
  /** Conviction per product in [-1, 1]. Missing means no view (treated as 0). */
  convictions: Record<string, number>
  regime: Regime
  policy: RiskPolicy
  /** Current weights, for hysteresis: a held position is not closed on a merely weak signal. */
  currentWeights: Record<string, number>
}

/**
 * Target weight of equity per product, as fractions that sum to at most the
 * exposure limit scaled by the regime.
 *
 * - conviction > ENTRY_THRESHOLD: weight grows linearly up to the per-asset cap.
 * - 0 <= conviction <= ENTRY_THRESHOLD: hold what is held (never add).
 * - conviction < 0: target zero (exit).
 */
export function targetWeights({ convictions, regime, policy, currentWeights }: TargetInputs): Record<string, number> {
  const cap = policy.maxPositionPct / 100
  const raw: Record<string, number> = {}
  for (const productId of policy.universe) {
    const c = convictions[productId] ?? 0
    const held = currentWeights[productId] ?? 0
    if (!Number.isFinite(c) || c < 0) raw[productId] = 0
    else if (c <= ENTRY_THRESHOLD) raw[productId] = Math.min(held, cap)
    else raw[productId] = Math.min(cap, ((c - ENTRY_THRESHOLD) / (1 - ENTRY_THRESHOLD)) * cap)
  }
  const limit = (policy.maxExposurePct / 100) * REGIME_EXPOSURE_SCALE[regime]
  const total = Object.values(raw).reduce((a, b) => a + b, 0)
  const scale = total > limit && total > 0 ? limit / total : 1
  const out: Record<string, number> = {}
  for (const productId of policy.universe) out[productId] = Math.floor(raw[productId]! * scale * 10_000) / 10_000
  return out
}

export interface PortfolioValuation {
  equityUsd: Big
  values: Record<string, Big>
  weights: Record<string, number>
}

/** Mark the portfolio at mid prices. A position with no price is valued at zero and reported. */
export function valuePortfolio(portfolio: AgentPortfolio, mids: Record<string, Big | undefined>): PortfolioValuation & { unpriced: string[] } {
  const values: Record<string, Big> = {}
  const unpriced: string[] = []
  let equity = portfolio.cashUsd
  for (const [productId, pos] of Object.entries(portfolio.positions)) {
    const mid = mids[productId]
    if (!mid) {
      if (pos.qty.gt(0)) unpriced.push(productId)
      values[productId] = ZERO
      continue
    }
    values[productId] = pos.qty.times(mid)
    equity = equity.plus(values[productId])
  }
  const weights: Record<string, number> = {}
  for (const [productId, v] of Object.entries(values)) weights[productId] = equity.gt(0) ? toNumber(v.div(equity)) : 0
  return { equityUsd: equity, values, weights, unpriced }
}

export interface RebalanceInputs {
  targets: Record<string, number>
  portfolio: AgentPortfolio
  mids: Record<string, Big | undefined>
  policy: RiskPolicy
}

/**
 * Turn target weights into trade intents. Exits and trims come first so their
 * proceeds can fund buys; within each side, the largest drift goes first.
 * Positions in products that are no longer in the universe are closed.
 */
export function planRebalance({ targets, portfolio, mids, policy }: RebalanceInputs): TradeIntent[] {
  const { equityUsd, values, weights } = valuePortfolio(portfolio, mids)
  if (equityUsd.lte(0)) return []
  const band = policy.rebalanceBandPct / 100
  const minOrder = dec(policy.minOrderUsd)
  const products = new Set([...policy.universe, ...Object.keys(portfolio.positions)])
  const sells: TradeIntent[] = []
  const buys: TradeIntent[] = []

  for (const productId of products) {
    if (!mids[productId]) continue // cannot size without a price; the risk engine would reject it anyway
    const inUniverse = policy.universe.includes(productId)
    const targetWeight = inUniverse ? (targets[productId] ?? 0) : 0
    const currentValue = values[productId] ?? ZERO
    const currentWeight = weights[productId] ?? 0
    const delta = equityUsd.times(targetWeight).minus(currentValue)
    const drift = Math.abs(targetWeight - currentWeight)

    if (targetWeight === 0 && currentValue.gt(0)) {
      // A full exit ignores the band: leaving risk on is never the cheaper mistake.
      sells.push({
        productId,
        side: 'SELL',
        notionalUsd: currentValue,
        closePosition: true,
        reason: inUniverse ? 'Signal turned negative: exit to cash.' : 'Product removed from your universe: exit to cash.',
        targetWeight,
        currentWeight,
      })
      continue
    }
    if (drift < band || delta.abs().lt(minOrder)) continue
    if (delta.lt(0)) {
      sells.push({ productId, side: 'SELL', notionalUsd: delta.abs(), reason: 'Above target weight: trim.', targetWeight, currentWeight })
    } else {
      buys.push({ productId, side: 'BUY', notionalUsd: delta, reason: 'Below target weight: add.', targetWeight, currentWeight })
    }
  }

  const bySize = (a: TradeIntent, b: TradeIntent) => b.notionalUsd.cmp(a.notionalUsd)
  return [...sells.sort(bySize), ...buys.sort(bySize)]
}
