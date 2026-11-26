/**
 * Platform limits and risk-policy validation.
 *
 * A user's policy can only ever be *tighter* than these. They are compiled into
 * the server, so no request, model output or database row can loosen them.
 */
import { z } from 'zod'
import { dec, minBig, toDecimalString, tryDec } from './money'
import type { RiskPolicy, RiskProfile } from './types'

/**
 * Spot products the agent may trade. USD-quoted, deep books, no leverage.
 * PAXG is a gold-backed token, which is how the agent can hold gold exposure
 * on a crypto exchange.
 */
export const TRADABLE_PRODUCTS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'PAXG-USD'] as const
export type TradableProductId = (typeof TRADABLE_PRODUCTS)[number]

export const PRODUCT_LABELS: Record<TradableProductId, string> = {
  'BTC-USD': 'Bitcoin',
  'ETH-USD': 'Ethereum',
  'SOL-USD': 'Solana',
  'PAXG-USD': 'PAX Gold',
}

export const PLATFORM_LIMITS = {
  minCapitalUsd: 50,
  /** Absolute ceiling regardless of plan. */
  maxCapitalUsd: 100_000,
  minOrderUsdFloor: 10,
  maxOrderUsdCeiling: 10_000,
  maxTradesPerDayCeiling: 24,
  minCooldownMinutes: 5,
  maxSlippageBpsCeiling: 100,
  dailyLossLimitPct: { min: 0.5, max: 20 },
  maxDrawdownPct: { min: 2, max: 50 },
  rebalanceBandPct: { min: 1, max: 25 },
  /** A quote older than this is not traded on. */
  maxQuoteAgeSeconds: 90,
  /** A signal older than this is not traded on. */
  maxSignalAgeHours: 12,
  /** New buys are skipped when the product moved more than this in 24 hours. */
  volatilityHaltPct: 20,
  /** A bid/ask spread wider than this means the quote is not trustworthy. */
  maxSpreadBps: 150,
  /** An order awaiting approval expires after this long. */
  approvalTtlMinutes: 30,
} as const

const decimalString = (label: string) =>
  z
    .string()
    .trim()
    .max(24)
    .refine((v) => tryDec(v) !== null && tryDec(v)!.gte(0), `${label} must be a non-negative decimal`)

export const riskPolicySchema = z
  .object({
    capitalUsd: decimalString('Capital'),
    maxExposurePct: z.number().min(0).max(100),
    maxPositionPct: z.number().min(1).max(100),
    maxOrderUsd: decimalString('Max order'),
    minOrderUsd: decimalString('Min order'),
    maxTradesPerDay: z.number().int().min(1).max(PLATFORM_LIMITS.maxTradesPerDayCeiling),
    maxDailyTurnoverUsd: decimalString('Daily turnover'),
    dailyLossLimitPct: z.number().min(PLATFORM_LIMITS.dailyLossLimitPct.min).max(PLATFORM_LIMITS.dailyLossLimitPct.max),
    maxDrawdownPct: z.number().min(PLATFORM_LIMITS.maxDrawdownPct.min).max(PLATFORM_LIMITS.maxDrawdownPct.max),
    rebalanceBandPct: z.number().min(PLATFORM_LIMITS.rebalanceBandPct.min).max(PLATFORM_LIMITS.rebalanceBandPct.max),
    cooldownMinutes: z.number().int().min(PLATFORM_LIMITS.minCooldownMinutes).max(24 * 60),
    maxSlippageBps: z.number().int().min(1).max(PLATFORM_LIMITS.maxSlippageBpsCeiling),
    universe: z
      .array(z.enum(TRADABLE_PRODUCTS))
      .min(1)
      .max(TRADABLE_PRODUCTS.length)
      .refine((u) => new Set(u).size === u.length, 'Universe has duplicates'),
  })
  .strict()

export type RiskPolicyInput = z.input<typeof riskPolicySchema>

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly field?: keyof RiskPolicy,
  ) {
    super(message)
    this.name = 'PolicyError'
  }
}

/**
 * Validate a policy and bind it to the plan's capital ceiling. Out-of-range
 * values are rejected, never silently widened; the two USD caps that depend on
 * capital are tightened to it.
 */
export function parseRiskPolicy(input: unknown, planMaxCapitalUsd: number): RiskPolicy {
  const parsed = riskPolicySchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new PolicyError(issue?.message ?? 'Invalid policy', issue?.path[0] as keyof RiskPolicy | undefined)
  }
  const p = parsed.data
  const capital = dec(p.capitalUsd)
  const capitalCeiling = Math.min(planMaxCapitalUsd, PLATFORM_LIMITS.maxCapitalUsd)
  if (capital.lt(PLATFORM_LIMITS.minCapitalUsd)) {
    throw new PolicyError(`Capital must be at least $${PLATFORM_LIMITS.minCapitalUsd}`, 'capitalUsd')
  }
  if (capital.gt(capitalCeiling)) {
    throw new PolicyError(`Capital is limited to $${capitalCeiling.toLocaleString('en-US')} on your plan`, 'capitalUsd')
  }
  const minOrder = dec(p.minOrderUsd)
  if (minOrder.lt(PLATFORM_LIMITS.minOrderUsdFloor)) {
    throw new PolicyError(`Minimum order must be at least $${PLATFORM_LIMITS.minOrderUsdFloor}`, 'minOrderUsd')
  }
  const maxOrder = dec(p.maxOrderUsd)
  if (maxOrder.gt(PLATFORM_LIMITS.maxOrderUsdCeiling)) {
    throw new PolicyError(`Largest order is limited to $${PLATFORM_LIMITS.maxOrderUsdCeiling.toLocaleString('en-US')}`, 'maxOrderUsd')
  }
  if (maxOrder.lt(minOrder)) {
    throw new PolicyError('Largest order must not be smaller than the minimum order', 'maxOrderUsd')
  }
  if (p.maxPositionPct > p.maxExposurePct && p.maxExposurePct > 0) {
    throw new PolicyError('A single position cannot exceed total exposure', 'maxPositionPct')
  }
  return {
    ...p,
    capitalUsd: toDecimalString(capital),
    minOrderUsd: toDecimalString(minOrder),
    maxOrderUsd: toDecimalString(minBig(maxOrder, capital)),
    maxDailyTurnoverUsd: toDecimalString(minBig(dec(p.maxDailyTurnoverUsd), capital.times(4))),
  }
}

interface ProfileShape {
  maxExposurePct: number
  maxPositionPct: number
  orderShare: number
  turnoverShare: number
  maxTradesPerDay: number
  dailyLossLimitPct: number
  maxDrawdownPct: number
  rebalanceBandPct: number
  cooldownMinutes: number
  maxSlippageBps: number
}

/**
 * Starting points, not advice. Bands are wide on purpose: at retail fee tiers
 * a round trip costs on the order of 1-2%, so small rebalances lose money.
 */
const PROFILES: Record<RiskProfile, ProfileShape> = {
  conservative: { maxExposurePct: 30, maxPositionPct: 15, orderShare: 0.1, turnoverShare: 0.3, maxTradesPerDay: 4, dailyLossLimitPct: 2, maxDrawdownPct: 8, rebalanceBandPct: 5, cooldownMinutes: 240, maxSlippageBps: 30 },
  balanced: { maxExposurePct: 60, maxPositionPct: 30, orderShare: 0.2, turnoverShare: 0.5, maxTradesPerDay: 6, dailyLossLimitPct: 3, maxDrawdownPct: 15, rebalanceBandPct: 4, cooldownMinutes: 120, maxSlippageBps: 40 },
  growth: { maxExposurePct: 90, maxPositionPct: 45, orderShare: 0.3, turnoverShare: 0.8, maxTradesPerDay: 8, dailyLossLimitPct: 5, maxDrawdownPct: 25, rebalanceBandPct: 3, cooldownMinutes: 60, maxSlippageBps: 50 },
}

export const RISK_PROFILES: RiskProfile[] = ['conservative', 'balanced', 'growth']

/** A complete, valid policy for a profile and an amount of capital. */
export function defaultPolicy(profile: RiskProfile, capitalUsd: number | string): RiskPolicy {
  const shape = PROFILES[profile]
  const capital = dec(capitalUsd)
  const minOrder = dec(PLATFORM_LIMITS.minOrderUsdFloor)
  const maxOrder = minBig(
    dec(PLATFORM_LIMITS.maxOrderUsdCeiling),
    capital.times(shape.orderShare).round(2, 0).lt(minOrder) ? minOrder : capital.times(shape.orderShare).round(2, 0),
  )
  return {
    capitalUsd: toDecimalString(capital),
    maxExposurePct: shape.maxExposurePct,
    maxPositionPct: shape.maxPositionPct,
    maxOrderUsd: toDecimalString(maxOrder),
    minOrderUsd: toDecimalString(minOrder),
    maxTradesPerDay: shape.maxTradesPerDay,
    maxDailyTurnoverUsd: toDecimalString(capital.times(shape.turnoverShare).round(2, 0)),
    dailyLossLimitPct: shape.dailyLossLimitPct,
    maxDrawdownPct: shape.maxDrawdownPct,
    rebalanceBandPct: shape.rebalanceBandPct,
    cooldownMinutes: shape.cooldownMinutes,
    maxSlippageBps: shape.maxSlippageBps,
    universe: [...TRADABLE_PRODUCTS],
  }
}
