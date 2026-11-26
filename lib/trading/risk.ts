/**
 * The risk engine. Pure, deterministic, and the last word on every order.
 *
 * Nothing reaches a broker without a ticket from `evaluateIntent`. The engine
 * never trusts where an intent came from: it re-derives everything it needs
 * from the context it is given and rejects on missing or stale data
 * ("fail closed").
 *
 * Two kinds of limit:
 *   - hard checks fail the order;
 *   - sizing checks shrink it to fit, then the minimum-size check decides
 *     whether what is left is still worth sending.
 *
 * Orders that reduce risk (sells) are never blocked by counters meant to stop
 * over-trading: a daily cap must not trap someone in a position.
 */
import { PLATFORM_LIMITS, TRADABLE_PRODUCTS } from './limits'
import { bpsOf, ceilTo, dec, floorTo, formatTo, maxBig, minBig, pctOf, toDecimalString, usd, ZERO, type Big } from './money'
import type { AgentMode, AgentPortfolio, AgentStatus, HaltReason, Ledger, ProductSpec, RiskCheck, RiskCheckCode, RiskDecision, RiskPolicy, TopOfBook, TradeIntent } from './types'

export interface LivePrerequisites {
  /** The subscription allows live trading. */
  entitled: boolean
  brokerConnected: boolean
  /** The connection carries the trade permission. */
  brokerCanTrade: boolean
  twoFactorEnabled: boolean
  riskAcknowledged: boolean
}

export interface RiskContext {
  now: Date
  mode: AgentMode
  status: AgentStatus
  ledger: Ledger
  /** Platform-wide stop. When true, nothing trades for anyone. */
  platformKillSwitch: boolean
  /** Checked only for the live ledger. */
  live: LivePrerequisites
  policy: RiskPolicy
  portfolio: AgentPortfolio
  /** Portfolio marked at mid prices. */
  equityUsd: Big
  positionValues: Record<string, Big | undefined>
  quotes: Record<string, TopOfBook | undefined>
  products: Record<string, ProductSpec | undefined>
  today: {
    /** Buys already placed this UTC day. */
    buyCount: number
    buyTurnoverUsd: Big
  }
  lastBuyAt: Record<string, Date | undefined>
  /** When the signals behind this intent were computed. */
  signalAsOf: Date
  /** Taker fee as a fraction, e.g. 0.006. */
  feeRate: Big
  /** Live ledger only: what the exchange reports as available right now. */
  exchangeAvailable?: { usd: Big; base: Record<string, Big | undefined> }
}

export interface HaltInputs {
  equityUsd: Big
  dayStartEquityUsd: Big
  peakEquityUsd: Big
  policy: Pick<RiskPolicy, 'dailyLossLimitPct' | 'maxDrawdownPct'>
}

/**
 * Circuit breakers on the whole agent. When one trips the agent stops placing
 * orders and stays stopped until a person resumes it. It does not liquidate:
 * selling into a fall is a decision for the account's owner.
 */
export function checkHalts({ equityUsd, dayStartEquityUsd, peakEquityUsd, policy }: HaltInputs): HaltReason | null {
  if (dayStartEquityUsd.gt(0)) {
    const dayLoss = dayStartEquityUsd.minus(equityUsd).div(dayStartEquityUsd)
    if (dayLoss.gte(pctOf(policy.dailyLossLimitPct))) return 'DAILY_LOSS_LIMIT'
  }
  if (peakEquityUsd.gt(0)) {
    const drawdown = peakEquityUsd.minus(equityUsd).div(peakEquityUsd)
    if (drawdown.gte(pctOf(policy.maxDrawdownPct))) return 'MAX_DRAWDOWN'
  }
  return null
}

export const HALT_MESSAGES: Record<HaltReason, string> = {
  DAILY_LOSS_LIMIT: 'Daily loss limit reached. The agent has stopped and will not trade until you resume it.',
  MAX_DRAWDOWN: 'Maximum drawdown reached. The agent has stopped and will not trade until you resume it.',
}

const PLATFORM_SET: ReadonlySet<string> = new Set(TRADABLE_PRODUCTS)

export function evaluateIntent(intent: TradeIntent, ctx: RiskContext): RiskDecision {
  const checks: RiskCheck[] = []
  let failed = false
  const pass = (code: RiskCheckCode, message: string) => checks.push({ code, outcome: 'pass', message })
  const adjust = (code: RiskCheckCode, message: string) => checks.push({ code, outcome: 'adjusted', message })
  const fail = (code: RiskCheckCode, message: string) => {
    checks.push({ code, outcome: 'fail', message })
    failed = true
  }
  const reject = (): RiskDecision => ({ approved: false, ticket: null, checks })

  const { productId, side } = intent
  const isBuy = side === 'BUY'
  const position = ctx.portfolio.positions[productId]
  const heldQty = position?.qty ?? ZERO

  // ---- hard gates -----------------------------------------------------------
  if (ctx.platformKillSwitch) {
    fail('KILL_SWITCH', 'Trading is stopped platform-wide.')
    return reject()
  }
  pass('KILL_SWITCH', 'Platform trading is enabled.')

  if (ctx.status !== 'active') {
    fail('AGENT_STATUS', ctx.status === 'halted' ? 'The agent is halted by a circuit breaker.' : 'The agent is paused.')
    return reject()
  }
  pass('AGENT_STATUS', 'The agent is active.')

  if (ctx.ledger === 'live') {
    const missing: string[] = []
    if (ctx.mode === 'paper') missing.push('the agent is in paper mode')
    if (!ctx.live.entitled) missing.push('an active subscription')
    if (!ctx.live.brokerConnected) missing.push('a linked Coinbase account')
    else if (!ctx.live.brokerCanTrade) missing.push('trade permission on the Coinbase link')
    if (!ctx.live.twoFactorEnabled) missing.push('two-factor authentication')
    if (!ctx.live.riskAcknowledged) missing.push('the risk acknowledgement')
    if (missing.length) {
      fail('LIVE_PREREQUISITES', `Live trading needs ${missing.join(', ')}.`)
      return reject()
    }
    pass('LIVE_PREREQUISITES', 'Subscription, Coinbase link, two-factor and risk acknowledgement are in place.')
  } else if (ctx.mode !== 'paper') {
    // A live-mode agent must never be evaluated against the paper book, or the reverse.
    fail('LIVE_PREREQUISITES', 'Ledger and mode disagree.')
    return reject()
  }

  if (typeof intent.notionalUsd?.gt !== 'function' || !intent.notionalUsd.gt(0)) {
    fail('ORDER_SIZE_MIN', 'The order has no size.')
    return reject()
  }

  if (isBuy) {
    if (!PLATFORM_SET.has(productId) || !ctx.policy.universe.includes(productId)) {
      fail('PRODUCT_ALLOWED', `${productId} is not in the agent's universe.`)
      return reject()
    }
  } else if (!heldQty.gt(0)) {
    fail('POSITION_AVAILABLE', `The agent holds no ${productId} to sell.`)
    return reject()
  }
  pass('PRODUCT_ALLOWED', `${productId} is allowed.`)

  const spec = ctx.products[productId]
  if (!spec || spec.productId !== productId || !spec.tradable) {
    fail('PRODUCT_TRADABLE', spec?.untradableReason ?? `${productId} is not available for trading right now.`)
    return reject()
  }
  if (spec.quoteCurrency !== 'USD') {
    fail('PRODUCT_TRADABLE', `${productId} is not quoted in USD.`)
    return reject()
  }
  pass('PRODUCT_TRADABLE', `${productId} is online.`)

  const quote = ctx.quotes[productId]
  if (!quote) {
    fail('QUOTE_FRESH', `No quote for ${productId}.`)
    return reject()
  }
  const ageSeconds = (ctx.now.getTime() - quote.asOf.getTime()) / 1000
  if (!Number.isFinite(ageSeconds) || ageSeconds > PLATFORM_LIMITS.maxQuoteAgeSeconds || ageSeconds < -5) {
    fail('QUOTE_FRESH', `The ${productId} quote is ${Math.round(ageSeconds)}s old; the limit is ${PLATFORM_LIMITS.maxQuoteAgeSeconds}s.`)
    return reject()
  }
  pass('QUOTE_FRESH', `Quote is ${Math.max(0, Math.round(ageSeconds))}s old.`)

  if (!quote.bid.gt(0) || !quote.ask.gt(0) || quote.ask.lt(quote.bid)) {
    fail('QUOTE_SANE', `The ${productId} quote is crossed or empty.`)
    return reject()
  }
  const mid = quote.bid.plus(quote.ask).div(2)
  const spreadBps = quote.ask.minus(quote.bid).div(mid).times(10_000)
  if (spreadBps.gt(PLATFORM_LIMITS.maxSpreadBps)) {
    fail('QUOTE_SANE', `The ${productId} spread is ${spreadBps.round(0).toFixed()} bps; the limit is ${PLATFORM_LIMITS.maxSpreadBps}.`)
    return reject()
  }
  pass('QUOTE_SANE', `Spread is ${spreadBps.round(1).toFixed()} bps.`)

  // An exit the user asked for (product removed from the universe) does not depend on a signal.
  const userDrivenExit = !isBuy && intent.closePosition === true && !ctx.policy.universe.includes(productId)
  if (!userDrivenExit) {
    const signalAgeHours = (ctx.now.getTime() - ctx.signalAsOf.getTime()) / 3_600_000
    if (!Number.isFinite(signalAgeHours) || signalAgeHours > PLATFORM_LIMITS.maxSignalAgeHours || signalAgeHours < -0.1) {
      fail('SIGNAL_FRESH', `Signals are ${signalAgeHours.toFixed(1)}h old; the limit is ${PLATFORM_LIMITS.maxSignalAgeHours}h.`)
      return reject()
    }
    pass('SIGNAL_FRESH', `Signals are ${Math.max(0, signalAgeHours).toFixed(1)}h old.`)
  }

  const slippage = bpsOf(ctx.policy.maxSlippageBps)

  // ---- sells: bounded by what the agent holds --------------------------------
  if (!isBuy) {
    let base = intent.closePosition ? heldQty : minBig(heldQty, intent.notionalUsd.div(mid))
    if (!intent.closePosition && intent.notionalUsd.div(mid).gt(heldQty)) {
      adjust('POSITION_AVAILABLE', 'Sell reduced to the quantity the agent holds.')
    } else {
      pass('POSITION_AVAILABLE', 'The agent holds the quantity.')
    }
    if (ctx.ledger === 'live') {
      const onExchange = ctx.exchangeAvailable?.base[productId]
      if (!onExchange || !onExchange.gt(0)) {
        fail('EXCHANGE_BALANCE', `Coinbase reports no available ${spec.baseCurrency}.`)
        return reject()
      }
      if (onExchange.lt(base)) {
        base = onExchange
        adjust('EXCHANGE_BALANCE', `Sell reduced to the ${spec.baseCurrency} available on Coinbase.`)
      } else {
        pass('EXCHANGE_BALANCE', 'Coinbase has the quantity available.')
      }
    }
    const limitPrice = ceilTo(quote.bid.times(dec(1).minus(slippage)), spec.priceIncrement)
    const baseSize = floorTo(base, spec.baseIncrement)
    const notional = baseSize.times(limitPrice)
    pass('PRICE_COLLAR', `Limit ${formatTo(limitPrice, spec.priceIncrement)}: at most ${ctx.policy.maxSlippageBps} bps below the bid.`)
    const floor = intent.closePosition ? dec(spec.quoteMinSize) : maxBig(dec(ctx.policy.minOrderUsd), dec(spec.quoteMinSize))
    if (!baseSize.gt(0) || baseSize.lt(spec.baseMinSize) || notional.lt(floor)) {
      fail('ORDER_SIZE_MIN', `Sell of $${usd(notional)} is below the minimum of $${usd(floor)}.`)
      return reject()
    }
    pass('ORDER_SIZE_MIN', `Sell of $${usd(notional)} clears the minimum.`)
    return {
      approved: !failed,
      ticket: { productId, side, baseSize: formatTo(baseSize, spec.baseIncrement), limitPrice: formatTo(limitPrice, spec.priceIncrement), notionalUsd: toDecimalString(notional) },
      checks,
    }
  }

  // ---- buys: every limit applies ---------------------------------------------
  if (quote.change24hPct !== null && Math.abs(quote.change24hPct) > PLATFORM_LIMITS.volatilityHaltPct) {
    fail('VOLATILITY_HALT', `${productId} moved ${quote.change24hPct.toFixed(1)}% in 24h; buys pause above ${PLATFORM_LIMITS.volatilityHaltPct}%.`)
    return reject()
  }
  pass('VOLATILITY_HALT', 'Within the 24h move limit.')

  const lastBuy = ctx.lastBuyAt[productId]
  if (lastBuy) {
    const minutes = (ctx.now.getTime() - lastBuy.getTime()) / 60_000
    if (minutes < ctx.policy.cooldownMinutes) {
      fail('COOLDOWN', `Last ${productId} buy was ${Math.max(0, Math.floor(minutes))} min ago; cooldown is ${ctx.policy.cooldownMinutes} min.`)
      return reject()
    }
  }
  pass('COOLDOWN', 'Cooldown has elapsed.')

  if (ctx.today.buyCount >= ctx.policy.maxTradesPerDay) {
    fail('DAILY_TRADE_COUNT', `Daily limit of ${ctx.policy.maxTradesPerDay} buys reached.`)
    return reject()
  }
  pass('DAILY_TRADE_COUNT', `${ctx.today.buyCount} of ${ctx.policy.maxTradesPerDay} buys used today.`)

  let notional = intent.notionalUsd
  /** Shrink to `cap`; fail when nothing is left. Returns false to stop. */
  const limitTo = (code: RiskCheckCode, cap: Big, what: string): boolean => {
    if (!cap.gt(0)) {
      fail(code, `${what}: no room left.`)
      return false
    }
    if (notional.gt(cap)) {
      notional = cap
      adjust(code, `${what}: reduced to $${usd(cap)}.`)
    } else {
      pass(code, `${what}: within limit.`)
    }
    return true
  }

  if (!limitTo('ORDER_SIZE_MAX', dec(ctx.policy.maxOrderUsd), 'Largest single order')) return reject()
  if (!limitTo('DAILY_TURNOVER', dec(ctx.policy.maxDailyTurnoverUsd).minus(ctx.today.buyTurnoverUsd), 'Daily buy turnover')) return reject()

  const positionValue = ctx.positionValues[productId] ?? ZERO
  if (!limitTo('POSITION_LIMIT', ctx.equityUsd.times(pctOf(ctx.policy.maxPositionPct)).minus(positionValue), `Position limit of ${ctx.policy.maxPositionPct}%`)) return reject()

  const exposure = Object.values(ctx.positionValues).reduce<Big>((sum, v) => (v ? sum.plus(v) : sum), ZERO)
  if (!limitTo('EXPOSURE_LIMIT', ctx.equityUsd.times(pctOf(ctx.policy.maxExposurePct)).minus(exposure), `Exposure limit of ${ctx.policy.maxExposurePct}%`)) return reject()

  // The ticket is sized at the limit price, so the most it can cost is its notional plus the fee.
  const costFactor = dec(1).plus(ctx.feeRate)
  if (!limitTo('CASH_AVAILABLE', ctx.portfolio.cashUsd.div(costFactor), "Agent's cash")) return reject()
  if (ctx.ledger === 'live') {
    const onExchange = ctx.exchangeAvailable?.usd ?? ZERO
    if (!limitTo('EXCHANGE_BALANCE', onExchange.div(costFactor), 'USD available on Coinbase')) return reject()
  }

  const limitPrice = floorTo(quote.ask.times(dec(1).plus(slippage)), spec.priceIncrement)
  if (!limitPrice.gt(0)) {
    fail('PRICE_COLLAR', 'Could not price the order.')
    return reject()
  }
  const baseSize = floorTo(notional.div(limitPrice), spec.baseIncrement)
  const ticketNotional = baseSize.times(limitPrice)
  pass('PRICE_COLLAR', `Limit ${formatTo(limitPrice, spec.priceIncrement)}: at most ${ctx.policy.maxSlippageBps} bps above the ask.`)

  const floor = maxBig(dec(ctx.policy.minOrderUsd), dec(spec.quoteMinSize))
  if (!baseSize.gt(0) || baseSize.lt(spec.baseMinSize) || ticketNotional.lt(floor)) {
    fail('ORDER_SIZE_MIN', `Buy of $${usd(ticketNotional)} is below the minimum of $${usd(floor)}.`)
    return reject()
  }
  pass('ORDER_SIZE_MIN', `Buy of $${usd(ticketNotional)} clears the minimum.`)

  return {
    approved: !failed,
    ticket: { productId, side, baseSize: formatTo(baseSize, spec.baseIncrement), limitPrice: formatTo(limitPrice, spec.priceIncrement), notionalUsd: toDecimalString(ticketNotional) },
    checks,
  }
}
