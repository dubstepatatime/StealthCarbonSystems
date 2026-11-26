/**
 * Yahoo Finance chart data for indices, metals futures and macro series.
 *
 * This is an unofficial endpoint with no service agreement. It is used because
 * it needs no key; treat it as best-effort. Every caller must cope with it
 * failing, and a licensed feed should replace it before the product depends on
 * these numbers commercially (see docs/operations.md).
 *
 * Shapes below were recorded from live responses (tests/fixtures/yahoo).
 */
import { z } from 'zod'
import { fetchJson, UpstreamError } from '../http'
import type { Instrument } from '../instruments'
import type { DailySeries, MarketState, Quote } from '../types'

const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'] as const

/** The endpoint answers 429 to clients that do not look like a browser. */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** The spark endpoint rejects more than 20 symbols per call. */
export const MAX_SYMBOLS_PER_CALL = 20

const tradingPeriod = z.object({ start: z.number(), end: z.number() }).partial()

const metaSchema = z
  .object({
    symbol: z.string(),
    currency: z.string().nullish(),
    regularMarketPrice: z.number().nullish(),
    previousClose: z.number().nullish(),
    chartPreviousClose: z.number().nullish(),
    regularMarketTime: z.number().nullish(),
    instrumentType: z.string().nullish(),
    currentTradingPeriod: z.object({ regular: tradingPeriod.nullish() }).partial().nullish(),
  })
  .passthrough()

const sparkSchema = z.object({
  spark: z.object({
    result: z
      .array(
        z.object({
          symbol: z.string(),
          response: z
            .array(
              z.object({
                meta: metaSchema,
                timestamp: z.array(z.number()).nullish(),
                indicators: z.object({ quote: z.array(z.object({ close: z.array(z.number().nullable()).nullish() }).passthrough()).nullish() }).passthrough().nullish(),
              }),
            )
            .min(1),
        }),
      )
      .nullable(),
    error: z.unknown().nullish(),
  }),
})

type SparkEntry = NonNullable<z.infer<typeof sparkSchema>['spark']['result']>[number]['response'][number]

export interface YahooOptions {
  fetchImpl?: typeof fetch
  now?: () => Date
}

async function fetchSpark(symbols: string[], range: string, interval: string, fetchImpl?: typeof fetch): Promise<Map<string, SparkEntry>> {
  if (symbols.length === 0) return new Map()
  if (symbols.length > MAX_SYMBOLS_PER_CALL) throw new RangeError(`At most ${MAX_SYMBOLS_PER_CALL} symbols per call`)
  const query = `symbols=${symbols.map(encodeURIComponent).join(',')}&range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`
  let lastError: unknown
  for (const host of HOSTS) {
    try {
      const body = await fetchJson(`https://${host}/v7/finance/spark?${query}`, { schema: sparkSchema, headers: HEADERS, fetchImpl })
      const out = new Map<string, SparkEntry>()
      for (const r of body.spark.result ?? []) out.set(r.symbol, r.response[0]!)
      return out
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new UpstreamError('Yahoo request failed', HOSTS[0])
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Keep at most `max` points, always including the last. */
export function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values
  const step = (values.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => values[Math.round(i * step)]!)
}

/**
 * Open if the clock is inside the regular session, or if the price moved in
 * the last 20 minutes (futures and some indices trade outside the session the
 * endpoint reports).
 */
export function marketStateOf(entry: Pick<SparkEntry, 'meta'>, now: Date): MarketState {
  const nowSec = now.getTime() / 1000
  const regular = entry.meta.currentTradingPeriod?.regular
  if (regular?.start != null && regular.end != null && nowSec >= regular.start && nowSec <= regular.end) return 'open'
  const updated = entry.meta.regularMarketTime
  if (updated == null) return 'unknown'
  return nowSec - updated <= 20 * 60 ? 'open' : 'closed'
}

/** Latest quotes with an intraday sparkline. Instruments the source does not return are simply absent. */
export async function fetchYahooQuotes(instruments: Instrument[], { fetchImpl, now = () => new Date() }: YahooOptions = {}): Promise<Map<string, Quote>> {
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]))
  const quotes = new Map<string, Quote>()
  const batches = await Promise.all(chunk([...bySymbol.keys()], MAX_SYMBOLS_PER_CALL).map((symbols) => fetchSpark(symbols, '1d', '5m', fetchImpl)))
  for (const batch of batches) {
    for (const [symbol, entry] of batch) {
      const instrument = bySymbol.get(symbol)
      if (!instrument) continue // never trust the source to echo only what was asked for
      const price = entry.meta.regularMarketPrice ?? null
      // With range=1d both fields are the previous session's close. (With a longer range,
      // chartPreviousClose is the close before the *range*, which is not a daily change.)
      const previousClose = entry.meta.previousClose ?? entry.meta.chartPreviousClose ?? null
      const valid = price !== null && Number.isFinite(price) && price > 0
      const change = valid && previousClose ? price - previousClose : null
      const closes = (entry.indicators?.quote?.[0]?.close ?? []).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      quotes.set(instrument.id, {
        id: instrument.id,
        symbol: instrument.symbol,
        name: instrument.name,
        segment: instrument.segment,
        price: valid ? price : null,
        previousClose,
        change,
        changePercent: change !== null && previousClose ? (change / previousClose) * 100 : null,
        currency: entry.meta.currency ?? instrument.currency,
        asOf: entry.meta.regularMarketTime ? new Date(entry.meta.regularMarketTime * 1000).toISOString() : null,
        marketState: marketStateOf(entry, now()),
        source: 'yahoo',
        delayed: true,
        spark: downsample(closes, 32),
        tradable: false,
        decimals: instrument.decimals,
        ...(valid ? {} : { error: 'No price from source' }),
      })
    }
  }
  return quotes
}

/** About a year of daily closes per instrument, oldest first. */
export async function fetchYahooDaily(instruments: Instrument[], { fetchImpl }: YahooOptions = {}): Promise<Map<string, DailySeries>> {
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]))
  const out = new Map<string, DailySeries>()
  const batches = await Promise.all(chunk([...bySymbol.keys()], MAX_SYMBOLS_PER_CALL).map((symbols) => fetchSpark(symbols, '1y', '1d', fetchImpl)))
  for (const batch of batches) {
    for (const [symbol, entry] of batch) {
      const instrument = bySymbol.get(symbol)
      if (!instrument) continue
      const timestamps = entry.timestamp ?? []
      const closes = entry.indicators?.quote?.[0]?.close ?? []
      const t: number[] = []
      const c: number[] = []
      for (let i = 0; i < Math.min(timestamps.length, closes.length); i++) {
        const v = closes[i]
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          t.push(timestamps[i]!)
          c.push(v)
        }
      }
      if (c.length) out.set(instrument.id, { id: instrument.id, symbol, t, c })
    }
  }
  return out
}
