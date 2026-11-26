/**
 * The market-data service: one snapshot of everything the desk watches,
 * assembled from independent sources that are allowed to fail independently.
 *
 * - Crypto and PAX Gold come from Coinbase (real time).
 * - Indices, metals futures and macro series come from Yahoo (may be delayed).
 * - If Yahoo is down, gold, silver and platinum fall back to the front-month
 *   Coinbase Derivatives contracts, so "gold and silver" has two sources.
 * - Anything that cannot be loaded is returned with a null price and an error,
 *   never with an invented or silently stale number.
 */
import 'server-only'
import { cached } from './cache'
import { INSTRUMENTS, instrumentsBySource, type Instrument } from './instruments'
import { fetchCandles, fetchCoinbaseDaily, fetchCoinbaseQuotes, fetchFrontFutures } from './providers/coinbase'
import { downsample, fetchYahooDaily, fetchYahooQuotes } from './providers/yahoo'
import { SEGMENT_ORDER, type DailySeries, type MarketSnapshot, type MarketSource, type Quote, type Segment, type SourceHealth } from './types'

export interface ServiceOptions {
  fetchImpl?: typeof fetch
  now?: () => Date
}

const TTL = {
  coinbaseQuotes: { ttlMs: 10_000, staleIfErrorMs: 120_000 },
  coinbaseSparks: { ttlMs: 5 * 60_000, staleIfErrorMs: 60 * 60_000 },
  coinbaseFutures: { ttlMs: 30_000, staleIfErrorMs: 5 * 60_000 },
  yahooQuotes: { ttlMs: 45_000, staleIfErrorMs: 15 * 60_000 },
  // No stale-if-error here: signals built from old history would be stamped as fresh and traded on.
  history: { ttlMs: 30 * 60_000, staleIfErrorMs: 0 },
} as const

const message = (err: unknown) => (err instanceof Error ? err.message : 'Source unavailable')

async function timed<T>(source: MarketSource, health: SourceHealth[], run: () => Promise<{ value: T; stale: boolean }>): Promise<T | null> {
  const started = performance.now()
  try {
    const { value, stale } = await run()
    health.push({ source, ok: !stale, latencyMs: Math.round(performance.now() - started), ...(stale ? { error: 'Serving the last good data' } : {}) })
    return value
  } catch (err) {
    health.push({ source, ok: false, latencyMs: Math.round(performance.now() - started), error: message(err) })
    return null
  }
}

function unavailable(instrument: Instrument): Quote {
  return {
    id: instrument.id,
    symbol: instrument.symbol,
    name: instrument.name,
    segment: instrument.segment,
    price: null,
    previousClose: null,
    change: null,
    changePercent: null,
    currency: instrument.currency,
    asOf: null,
    marketState: 'unknown',
    source: instrument.source,
    delayed: instrument.source === 'yahoo',
    spark: [],
    tradable: false,
    decimals: instrument.decimals,
    error: 'Source unavailable',
  }
}

async function loadCryptoSparks(instruments: Instrument[], options: ServiceOptions): Promise<Map<string, number[]>> {
  const results = await Promise.allSettled(instruments.map((i) => fetchCandles(i.symbol, 'FIFTEEN_MINUTE', 96, options)))
  const sparks = new Map<string, number[]>()
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value.length) sparks.set(instruments[idx]!.symbol, downsample(r.value.map((c) => c.c), 32))
  })
  return sparks
}

export async function getMarketSnapshot(options: ServiceOptions = {}): Promise<MarketSnapshot> {
  const now = options.now ?? (() => new Date())
  const clock = { now: () => now().getTime() }
  const coinbase = instrumentsBySource('coinbase')
  const yahoo = instrumentsBySource('yahoo')
  const health: SourceHealth[] = []

  const sparksPromise = cached('coinbase:sparks', () => loadCryptoSparks(coinbase, options), { ...TTL.coinbaseSparks, ...clock })
    .then((r) => r.value)
    .catch(() => new Map<string, number[]>())

  const [coinbaseQuotes, yahooQuotes] = await Promise.all([
    timed('coinbase', health, async () => cached('coinbase:quotes', async () => fetchCoinbaseQuotes(coinbase, await sparksPromise, options), { ...TTL.coinbaseQuotes, ...clock })),
    timed('yahoo', health, () => cached('yahoo:quotes', () => fetchYahooQuotes(yahoo, options), { ...TTL.yahooQuotes, ...clock })),
  ])

  const byId = new Map<string, Quote>([...(coinbaseQuotes ?? []), ...(yahooQuotes ?? [])])

  // Second source for metals when the first has no price for them.
  const missingMetals = INSTRUMENTS.filter((i) => i.fallbackFutureRoot && byId.get(i.id)?.price == null)
  if (missingMetals.length) {
    const futures = await timed('coinbase-derivatives', health, () => cached('coinbase:futures', () => fetchFrontFutures(INSTRUMENTS.filter((i) => i.fallbackFutureRoot), options), { ...TTL.coinbaseFutures, ...clock }))
    for (const instrument of missingMetals) {
      const q = futures?.get(instrument.id)
      if (q) byId.set(instrument.id, q)
    }
  }

  const segments = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, [] as Quote[]])) as Record<Segment, Quote[]>
  const macro: Quote[] = []
  for (const instrument of INSTRUMENTS) {
    const quote = byId.get(instrument.id) ?? unavailable(instrument)
    if (instrument.segment === 'macro') macro.push(quote)
    else segments[instrument.segment].push(quote)
  }
  return { segments, macro, generatedAt: now().toISOString(), sources: health }
}

/** Daily closes for every instrument that has them, keyed by instrument id. Missing series are simply absent. */
export async function getDailyHistory(options: ServiceOptions = {}): Promise<Record<string, DailySeries>> {
  const now = options.now ?? (() => new Date())
  const { value } = await cached(
    'history:daily',
    async () => {
      const spot = instrumentsBySource('coinbase')
      const [yahoo, ...coinbase] = await Promise.allSettled([fetchYahooDaily(instrumentsBySource('yahoo'), options), ...spot.map((i) => fetchCoinbaseDaily(i, options))])
      const out: Record<string, DailySeries> = {}
      if (yahoo.status === 'fulfilled') for (const [id, series] of yahoo.value) out[id] = series
      coinbase.forEach((r) => {
        if (r.status === 'fulfilled' && r.value) out[r.value.id] = r.value
      })
      if (Object.keys(out).length === 0) throw new Error('No market history available')
      return out
    },
    { ...TTL.history, now: () => now().getTime() },
  )
  return value
}
