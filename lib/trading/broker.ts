/**
 * The broker boundary. The engine talks to this interface only; whether an
 * order is simulated or sent to Coinbase is decided by which implementation it
 * is handed, never by a flag inside the order.
 */
import { bpsOf, dec, maxBig, minBig, type Big } from './money'
import type { Fill, Ledger, OrderTicket, ProductSpec, TopOfBook } from './types'

export interface PlaceOrderRequest {
  /** Idempotency key. The same key must never create two orders. */
  clientOrderId: string
  ticket: OrderTicket
}

export type PlaceOrderResult =
  | { status: 'filled'; exchangeOrderId: string; fill: Fill }
  | { status: 'partially_filled'; exchangeOrderId: string; fill: Fill }
  /** Accepted by the exchange; the fill is not known yet and must be reconciled. */
  | { status: 'submitted'; exchangeOrderId: string }
  /** The order did not trade (an immediate-or-cancel order that found no price inside the collar). */
  | { status: 'cancelled'; exchangeOrderId: string | null; reason: string }
  /** The exchange refused it. Safe to treat as "nothing happened". */
  | { status: 'failed'; reason: string }

export interface Broker {
  readonly ledger: Ledger
  getProducts(productIds: string[]): Promise<Record<string, ProductSpec>>
  getTopOfBook(productIds: string[]): Promise<Record<string, TopOfBook>>
  /** Taker fee as a fraction. */
  getFeeRate(): Promise<Big>
  placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult>
  /** Live only: balances the exchange reports as available. */
  getAvailable?(productIds: string[]): Promise<{ usd: Big; base: Record<string, Big | undefined> }>
}

/** Fee assumed for paper trading: a conservative retail taker rate, so paper results are not flattered. */
export const PAPER_TAKER_FEE_BPS = 120
/** Extra adverse price movement assumed on every paper fill. */
export const PAPER_SLIPPAGE_BPS = 5

/**
 * Fill an immediate-or-cancel limit order against a top-of-book quote, the way
 * the paper ledger does. Returns null when the price is outside the limit.
 */
export function simulateFill(ticket: OrderTicket, quote: TopOfBook, feeRate: Big, slippageBps = PAPER_SLIPPAGE_BPS): Fill | null {
  const limit = dec(ticket.limitPrice)
  const baseSize = dec(ticket.baseSize)
  const slip = bpsOf(slippageBps)
  let price: Big
  if (ticket.side === 'BUY') {
    if (quote.ask.gt(limit)) return null
    price = minBig(limit, quote.ask.times(dec(1).plus(slip)))
  } else {
    if (quote.bid.lt(limit)) return null
    price = maxBig(limit, quote.bid.times(dec(1).minus(slip)))
  }
  const quoteUsd = baseSize.times(price)
  return { baseSize, price, quoteUsd, feeUsd: quoteUsd.times(feeRate) }
}
