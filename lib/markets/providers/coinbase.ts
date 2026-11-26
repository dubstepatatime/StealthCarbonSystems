/**
 * Coinbase public market data (Advanced Trade "market" endpoints, no auth).
 *
 * Used three ways: display quotes for the crypto and metals segments, the
 * product rules and top-of-book the risk engine needs, and daily candles for
 * signals. Shapes were recorded from live responses (tests/fixtures/coinbase).
 */
import { z } from 'zod'
import type { Candle } from '@/lib/trading/indicators'
import { dec, tryDec } from '@/lib/trading/money'
import type { ProductSpec, TopOfBook } from '@/lib/trading/types'
import { fetchJson } from '../http'
import type { Instrument } from '../instruments'
import type { DailySeries, Quote } from '../types'

const BASE = 'https://api.coinbase.com/api/v3/brokerage'

/** The candles endpoint refuses 350 or more candles per request. */
export const MAX_CANDLES = 349

const futureDetails = z
  .object({
    contract_root_unit: z.string().nullish(),
    contract_expiry: z.string().nullish(),
    contract_display_name: z.string().nullish(),
  })
  .passthrough()

const productSchema = z
  .object({
    product_id: z.string(),
    price: z.string().nullish(),
    price_percentage_change_24h: z.string().nullish(),
    base_increment: z.string().nullish(),
    quote_increment: z.string().nullish(),
    price_increment: z.string().nullish(),
    base_min_size: z.string().nullish(),
    quote_min_size: z.string().nullish(),
    base_currency_id: z.string().nullish(),
    quote_currency_id: z.string().nullish(),
    product_type: z.string().nullish(),
    status: z.string().nullish(),
    is_disabled: z.boolean().nullish(),
    trading_disabled: z.boolean().nullish(),
    cancel_only: z.boolean().nullish(),
    post_only: z.boolean().nullish(),
    view_only: z.boolean().nullish(),
    auction_mode: z.boolean().nullish(),
    future_product_details: futureDetails.nullish(),
  })
  .passthrough()

export type CoinbaseProduct = z.infer<typeof productSchema>

const productsSchema = z.object({ products: z.array(productSchema).nullish() }).passthrough()

const candlesSchema = z.object({
  candles: z.array(z.object({ start: z.string(), low: z.string(), high: z.string(), open: z.string(), close: z.string(), volume: z.string() })).nullish(),
})

const bookSchema = z.object({
  pricebook: z.object({
    product_id: z.string(),
    bids: z.array(z.object({ price: z.string(), size: z.string() })),
    asks: z.array(z.object({ price: z.string(), size: z.string() })),
    time: z.string().nullish(),
  }),
})

export interface CoinbaseOptions {
  fetchImpl?: typeof fetch
  now?: () => Date
}

const PRODUCT_ID_RE = /^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}(-[A-Z0-9]{2,12})?$/

function assertProductIds(ids: string[]): void {
  for (const id of ids) if (!PRODUCT_ID_RE.test(id)) throw new RangeError(`Not a product id: ${id}`)
}

const num = (s: string | null | undefined): number | null => {
  if (s == null || s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export async function fetchSpotProducts(productIds: string[], { fetchImpl }: CoinbaseOptions = {}): Promise<Map<string, CoinbaseProduct>> {
  if (productIds.length === 0) return new Map()
  assertProductIds(productIds)
  const query = productIds.map((id) => `product_ids=${encodeURIComponent(id)}`).join('&')
  const body = await fetchJson(`${BASE}/market/products?product_type=SPOT&${query}`, { schema: productsSchema, fetchImpl })
  const wanted = new Set(productIds)
  const out = new Map<string, CoinbaseProduct>()
  for (const p of body.products ?? []) if (wanted.has(p.product_id) && p.product_type === 'SPOT') out.set(p.product_id, p)
  return out
}

/** Why a product cannot take the agent's orders right now, or null when it can. */
export function untradableReason(p: CoinbaseProduct): string | null {
  if (p.product_type !== 'SPOT') return `${p.product_id} is not a spot product.`
  if (p.status !== 'online') return `${p.product_id} is ${p.status || 'offline'}.`
  if (p.is_disabled || p.trading_disabled) return `Trading in ${p.product_id} is disabled.`
  if (p.view_only) return `${p.product_id} is view-only.`
  if (p.cancel_only) return `${p.product_id} is in cancel-only mode.`
  if (p.post_only) return `${p.product_id} is in post-only mode.`
  if (p.auction_mode) return `${p.product_id} is in an auction.`
  for (const field of ['base_increment', 'quote_increment', 'price_increment', 'base_min_size', 'quote_min_size'] as const) {
    const v = tryDec(p[field] ?? '')
    if (!v || !v.gt(0)) return `${p.product_id} is missing its ${field.replace(/_/g, ' ')}.`
  }
  if (!p.base_currency_id || !p.quote_currency_id) return `${p.product_id} is missing its currencies.`
  return null
}

export function toProductSpec(p: CoinbaseProduct): ProductSpec {
  const reason = untradableReason(p)
  return {
    productId: p.product_id,
    baseCurrency: p.base_currency_id ?? '',
    quoteCurrency: p.quote_currency_id ?? '',
    baseIncrement: p.base_increment ?? '0',
    quoteIncrement: p.quote_increment ?? '0',
    priceIncrement: p.price_increment ?? '0',
    baseMinSize: p.base_min_size ?? '0',
    quoteMinSize: p.quote_min_size ?? '0',
    tradable: reason === null,
    ...(reason ? { untradableReason: reason } : {}),
  }
}

export async function fetchProductSpecs(productIds: string[], options: CoinbaseOptions = {}): Promise<Record<string, ProductSpec>> {
  const products = await fetchSpotProducts(productIds, options)
  return Object.fromEntries([...products].map(([id, p]) => [id, toProductSpec(p)]))
}

/** Best bid and ask for one product, as exact decimals. */
export async function fetchTopOfBook(productId: string, { fetchImpl, now = () => new Date() }: CoinbaseOptions = {}, change24hPct: number | null = null): Promise<TopOfBook> {
  assertProductIds([productId])
  const body = await fetchJson(`${BASE}/market/product_book?product_id=${encodeURIComponent(productId)}&limit=1`, { schema: bookSchema, fetchImpl })
  const bid = tryDec(body.pricebook.bids[0]?.price ?? '')
  const ask = tryDec(body.pricebook.asks[0]?.price ?? '')
  if (body.pricebook.product_id !== productId || !bid || !ask) throw new Error(`No two-sided book for ${productId}`)
  const stamped = body.pricebook.time ? new Date(body.pricebook.time) : null
  return { bid, ask, asOf: stamped && !Number.isNaN(stamped.getTime()) ? stamped : now(), change24hPct }
}

export type Granularity = 'FIFTEEN_MINUTE' | 'ONE_HOUR' | 'ONE_DAY'
const GRANULARITY_SECONDS: Record<Granularity, number> = { FIFTEEN_MINUTE: 900, ONE_HOUR: 3_600, ONE_DAY: 86_400 }

/** The last `count` candles, oldest first. */
export async function fetchCandles(productId: string, granularity: Granularity, count: number, { fetchImpl, now = () => new Date() }: CoinbaseOptions = {}): Promise<Candle[]> {
  assertProductIds([productId])
  const n = Math.max(1, Math.min(MAX_CANDLES, Math.floor(count)))
  const end = Math.floor(now().getTime() / 1000)
  const start = end - n * GRANULARITY_SECONDS[granularity]
  const body = await fetchJson(`${BASE}/market/products/${encodeURIComponent(productId)}/candles?start=${start}&end=${end}&granularity=${granularity}`, { schema: candlesSchema, fetchImpl })
  const candles: Candle[] = []
  for (const c of body.candles ?? []) {
    const candle = { t: Number(c.start), o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close), v: Number(c.volume) }
    if (Object.values(candle).every(Number.isFinite) && candle.c > 0) candles.push(candle)
  }
  return candles.sort((a, b) => a.t - b.t)
}

export async function fetchCoinbaseDaily(instrument: Instrument, options: CoinbaseOptions = {}): Promise<DailySeries | null> {
  const candles = await fetchCandles(instrument.symbol, 'ONE_DAY', MAX_CANDLES, options)
  if (candles.length === 0) return null
  return { id: instrument.id, symbol: instrument.symbol, t: candles.map((c) => c.t), c: candles.map((c) => c.c) }
}

/** Display quotes for spot instruments. `sparks` supplies recent closes per product id, when available. */
export async function fetchCoinbaseQuotes(instruments: Instrument[], sparks: Map<string, number[]> = new Map(), options: CoinbaseOptions = {}): Promise<Map<string, Quote>> {
  const now = (options.now ?? (() => new Date()))()
  const products = await fetchSpotProducts(instruments.map((i) => i.symbol), options)
  const quotes = new Map<string, Quote>()
  for (const instrument of instruments) {
    const p = products.get(instrument.symbol)
    if (!p) continue
    const price = num(p.price)
    const pct = num(p.price_percentage_change_24h)
    const valid = price !== null && price > 0
    const previousClose = valid && pct !== null && pct > -100 ? price / (1 + pct / 100) : null
    quotes.set(instrument.id, {
      id: instrument.id,
      symbol: instrument.symbol,
      name: instrument.name,
      segment: instrument.segment,
      price: valid ? price : null,
      previousClose,
      change: valid && previousClose !== null ? price - previousClose : null,
      changePercent: valid ? pct : null,
      currency: 'USD',
      asOf: now.toISOString(),
      marketState: 'open',
      source: 'coinbase',
      delayed: false,
      spark: sparks.get(instrument.symbol) ?? [],
      tradable: Boolean(instrument.tradable) && untradableReason(p) === null,
      decimals: instrument.decimals,
      ...(valid ? {} : { error: 'No price from source' }),
    })
  }
  return quotes
}

/**
 * The nearest unexpired Coinbase Derivatives contract for each root (for
 * example CDEGLD for gold). A second source for metals when the primary is down.
 */
export async function fetchFrontFutures(instruments: Instrument[], { fetchImpl, now = () => new Date() }: CoinbaseOptions = {}): Promise<Map<string, Quote>> {
  const wanted = instruments.filter((i) => i.fallbackFutureRoot)
  if (wanted.length === 0) return new Map()
  const body = await fetchJson(`${BASE}/market/products?product_type=FUTURE&limit=500`, { schema: productsSchema, fetchImpl })
  const at = now()
  const quotes = new Map<string, Quote>()
  for (const instrument of wanted) {
    const front = (body.products ?? [])
      .filter((p) => p.product_type === 'FUTURE' && p.future_product_details?.contract_root_unit === instrument.fallbackFutureRoot)
      .map((p) => ({ p, expiry: new Date(p.future_product_details?.contract_expiry ?? ''), price: num(p.price) }))
      .filter((x) => x.price !== null && x.price > 0 && !Number.isNaN(x.expiry.getTime()) && x.expiry.getTime() > at.getTime())
      .sort((a, b) => a.expiry.getTime() - b.expiry.getTime())[0]
    if (!front) continue
    const pct = num(front.p.price_percentage_change_24h)
    const price = front.price!
    const previousClose = pct !== null && pct > -100 ? price / (1 + pct / 100) : null
    quotes.set(instrument.id, {
      id: instrument.id,
      symbol: front.p.product_id,
      name: instrument.name,
      segment: instrument.segment,
      price,
      previousClose,
      change: previousClose !== null ? price - previousClose : null,
      changePercent: pct,
      currency: 'USD',
      asOf: at.toISOString(),
      marketState: 'open',
      source: 'coinbase-derivatives',
      delayed: false,
      spark: [],
      tradable: false,
      decimals: instrument.decimals,
    })
  }
  return quotes
}

/** Mid price as a decimal, for marking a portfolio. */
export const midOf = (book: TopOfBook) => book.bid.plus(book.ask).div(dec(2))
