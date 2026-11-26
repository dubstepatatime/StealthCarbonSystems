/**
 * The agent's book-keeping. Pure functions over an immutable portfolio.
 *
 * The agent keeps its own ledger of cash and positions, separate from whatever
 * else is in the user's exchange account. That is what guarantees it never
 * spends more than the capital it was given and never sells an asset it did
 * not buy.
 */
import { ZERO, type Big } from './money'
import type { AgentPortfolio, Fill, Side } from './types'

export function emptyPortfolio(cashUsd: Big): AgentPortfolio {
  return { cashUsd, positions: {} }
}

export interface FillResult {
  portfolio: AgentPortfolio
  /** Profit or loss realized by this fill, fees included. Zero for buys. */
  realizedPnlUsd: Big
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerError'
  }
}

/** Apply an execution to the book. Throws rather than let cash or a quantity go negative. */
export function applyFill(portfolio: AgentPortfolio, productId: string, side: Side, fill: Fill): FillResult {
  if (!fill.baseSize.gt(0) || fill.quoteUsd.lt(0) || fill.feeUsd.lt(0)) throw new LedgerError('Invalid fill')
  const current = portfolio.positions[productId] ?? { qty: ZERO, costUsd: ZERO }
  const positions = { ...portfolio.positions }

  if (side === 'BUY') {
    const spent = fill.quoteUsd.plus(fill.feeUsd)
    if (spent.gt(portfolio.cashUsd)) throw new LedgerError('Fill costs more than the agent has in cash')
    positions[productId] = { qty: current.qty.plus(fill.baseSize), costUsd: current.costUsd.plus(spent) }
    return { portfolio: { cashUsd: portfolio.cashUsd.minus(spent), positions }, realizedPnlUsd: ZERO }
  }

  if (fill.baseSize.gt(current.qty)) throw new LedgerError('Fill sells more than the agent holds')
  const proceeds = fill.quoteUsd.minus(fill.feeUsd)
  const costRemoved = current.qty.gt(0) ? current.costUsd.times(fill.baseSize).div(current.qty) : ZERO
  const qty = current.qty.minus(fill.baseSize)
  if (qty.gt(0)) positions[productId] = { qty, costUsd: current.costUsd.minus(costRemoved) }
  else delete positions[productId]
  return { portfolio: { cashUsd: portfolio.cashUsd.plus(proceeds), positions }, realizedPnlUsd: proceeds.minus(costRemoved) }
}
