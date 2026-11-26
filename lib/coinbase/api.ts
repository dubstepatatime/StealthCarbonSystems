/**
 * The authenticated Coinbase client and the live broker built on it.
 *
 * Deny by default: only the five requests listed in ROUTES can be made with a
 * user's token, the host is fixed, and bodies are built from validated,
 * typed values. Coinbase's trade scope also reaches futures and equities, so
 * "spot products from our allow-list only" is enforced here and in the risk
 * engine, not by Coinbase.
 */
import 'server-only'
import { z } from 'zod'
import type { Db } from '@/lib/db/client'
import { fetchProductSpecs, fetchSpotProducts, fetchTopOfBook } from '@/lib/markets/providers/coinbase'
import type { Broker, PlaceOrderRequest, PlaceOrderResult } from '@/lib/trading/broker'
import { TRADABLE_PRODUCTS } from '@/lib/trading/limits'
import { dec, tryDec, ZERO, type Big } from '@/lib/trading/money'
import type { TopOfBook } from '@/lib/trading/types'
import { getAccessToken, markNeedsReauth } from './connection'

const HOST = 'https://api.coinbase.com'
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const ALLOWED_PRODUCTS: ReadonlySet<string> = new Set(TRADABLE_PRODUCTS)

type Route = { method: 'GET' | 'POST'; path: string }
const ROUTES = {
  user: (): Route => ({ method: 'GET', path: '/v2/user' }),
  accounts: (): Route => ({ method: 'GET', path: '/api/v3/brokerage/accounts?limit=250' }),
  fees: (): Route => ({ method: 'GET', path: '/api/v3/brokerage/transaction_summary?product_type=SPOT' }),
  createOrder: (): Route => ({ method: 'POST', path: '/api/v3/brokerage/orders' }),
  order: (id: string): Route => {
    if (!ID_RE.test(id)) throw new Error('Bad order id')
    return { method: 'GET', path: `/api/v3/brokerage/orders/historical/${encodeURIComponent(id)}` }
  },
}

export class CoinbaseAuthError extends Error {}

async function call<T>(token: string, route: Route, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const res = await fetch(HOST + route.path, {
    method: route.method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'CB-VERSION': '2024-01-01', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 401) throw new CoinbaseAuthError('Coinbase rejected the token')
  const text = await res.text()
  if (!res.ok) throw new Error(`Coinbase answered ${res.status}`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('Coinbase did not return JSON')
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new Error('Coinbase returned an unexpected shape')
  return parsed.data
}

const userSchema = z.object({ data: z.object({ id: z.string().min(1) }).passthrough() })
export const fetchCoinbaseUserId = async (token: string) => (await call(token, ROUTES.user(), userSchema)).data.id

const accountsSchema = z.object({
  accounts: z.array(z.object({ currency: z.string(), available_balance: z.object({ value: z.string() }), retail_portfolio_id: z.string().nullish(), platform: z.string().nullish(), active: z.boolean().nullish() }).passthrough()),
})
const feesSchema = z.object({ fee_tier: z.object({ taker_fee_rate: z.string() }).passthrough() }).passthrough()
const createSchema = z
  .object({
    success: z.boolean(),
    success_response: z.object({ order_id: z.string(), product_id: z.string().nullish(), side: z.string().nullish(), client_order_id: z.string().nullish() }).passthrough().nullish(),
    error_response: z.object({ error: z.string().nullish(), message: z.string().nullish(), new_order_failure_reason: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough()
const orderSchema = z.object({
  order: z.object({ order_id: z.string(), status: z.string(), filled_size: z.string().nullish(), filled_value: z.string().nullish(), average_filled_price: z.string().nullish(), total_fees: z.string().nullish() }).passthrough(),
})

export interface Balances {
  usd: Big
  base: Record<string, Big | undefined>
  portfolioId: string | null
}

export async function fetchBalances(token: string): Promise<Balances> {
  const { accounts } = await call(token, ROUTES.accounts(), accountsSchema)
  const spot = accounts.filter((a) => a.active !== false && (!a.platform || a.platform === 'ACCOUNT_PLATFORM_CONSUMER'))
  const base: Record<string, Big | undefined> = {}
  let usd = ZERO
  let portfolioId: string | null = null
  for (const a of spot) {
    const value = tryDec(a.available_balance.value) ?? ZERO
    if (a.currency === 'USD') {
      usd = value
      portfolioId = a.retail_portfolio_id ?? portfolioId
    } else base[`${a.currency}-USD`] = value
  }
  return { usd, base, portfolioId }
}

/** The live broker for one user. Returns null when there is no usable Coinbase link. */
export async function createCoinbaseBroker(db: Db, userId: string): Promise<Broker | null> {
  const first = await getAccessToken(db, userId)
  if (!first) return null
  const withToken = async <T>(fn: (token: string) => Promise<T>): Promise<T> => {
    const token = await getAccessToken(db, userId)
    if (!token) throw new CoinbaseAuthError('No usable Coinbase link')
    try {
      return await fn(token)
    } catch (err) {
      if (err instanceof CoinbaseAuthError) await markNeedsReauth(db, userId, 'unauthorized')
      throw err
    }
  }

  return {
    ledger: 'live',
    getProducts: (ids) => fetchProductSpecs(ids.filter((id) => ALLOWED_PRODUCTS.has(id))),
    async getTopOfBook(ids) {
      const allowed = ids.filter((id) => ALLOWED_PRODUCTS.has(id))
      const products = await fetchSpotProducts(allowed)
      const out: Record<string, TopOfBook> = {}
      await Promise.all(
        allowed.map(async (id) => {
          const pct = Number(products.get(id)?.price_percentage_change_24h)
          out[id] = await fetchTopOfBook(id, {}, Number.isFinite(pct) ? pct : null)
        }),
      )
      return out
    },
    getFeeRate: () => withToken(async (t) => dec((await call(t, ROUTES.fees(), feesSchema)).fee_tier.taker_fee_rate)),
    getAvailable: () => withToken(async (t) => fetchBalances(t)),
    placeOrder: ({ clientOrderId, ticket }: PlaceOrderRequest): Promise<PlaceOrderResult> =>
      withToken(async (token) => {
        if (!ALLOWED_PRODUCTS.has(ticket.productId)) return { status: 'failed', reason: 'Product is not on the allow-list.' }
        const { portfolioId } = await fetchBalances(token)
        if (!portfolioId) return { status: 'failed', reason: 'No USD spot portfolio is shared with this app.' }
        // An immediate-or-cancel limit order: it trades inside the price collar right now or not at all.
        const body = {
          client_order_id: clientOrderId,
          product_id: ticket.productId,
          side: ticket.side,
          retail_portfolio_id: portfolioId,
          order_configuration: { sor_limit_ioc: { base_size: ticket.baseSize, limit_price: ticket.limitPrice } },
        }
        const created = await call(token, ROUTES.createOrder(), createSchema, body)
        const ok = created.success_response
        if (!created.success || !ok) return { status: 'failed', reason: created.error_response?.message || created.error_response?.new_order_failure_reason || created.error_response?.error || 'Order refused.' }
        // A replayed client order id returns the original order: make sure it is the one we meant.
        if ((ok.product_id && ok.product_id !== ticket.productId) || (ok.side && ok.side !== ticket.side)) return { status: 'failed', reason: 'Exchange returned a different order for this id.' }
        for (let attempt = 0; attempt < 4; attempt++) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
          const result = await readOrder(token, ok.order_id)
          if (result.status !== 'submitted') return result
        }
        return { status: 'submitted', exchangeOrderId: ok.order_id }
      }),
  }
}

/** Read an order's outcome. Used right after placing and again when reconciling. */
export async function readOrder(token: string, orderId: string): Promise<PlaceOrderResult> {
  const { order } = await call(token, ROUTES.order(orderId), orderSchema)
  const baseSize = tryDec(order.filled_size ?? '') ?? ZERO
  const quoteUsd = tryDec(order.filled_value ?? '') ?? ZERO
  const feeUsd = tryDec(order.total_fees ?? '') ?? ZERO
  const done = ['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(order.status)
  if (!done) return { status: 'submitted', exchangeOrderId: order.order_id }
  if (!baseSize.gt(0)) return order.status === 'FAILED' ? { status: 'failed', reason: 'Order failed at the exchange.' } : { status: 'cancelled', exchangeOrderId: order.order_id, reason: 'No price inside the collar.' }
  const fill = { baseSize, quoteUsd, feeUsd, price: tryDec(order.average_filled_price ?? '') ?? quoteUsd.div(baseSize) }
  return order.status === 'FILLED' ? { status: 'filled', exchangeOrderId: order.order_id, fill } : { status: 'partially_filled', exchangeOrderId: order.order_id, fill }
}
