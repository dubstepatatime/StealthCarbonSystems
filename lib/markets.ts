export type Segment = 'global' | 'metals' | 'us' | 'crypto'

export interface Instrument {
  symbol: string
  name: string
}

export interface Quote {
  symbol: string
  name: string
  price: number | null
  previousClose: number | null
  change: number | null
  changePercent: number | null
  currency: string
  error?: string
}

export const SEGMENTS: Record<
  Segment,
  { label: string; description: string; instruments: Instrument[] }
> = {
  global: {
    label: 'Global Markets',
    description: 'Major international equity indices',
    instruments: [
      { symbol: '^FTSE', name: 'FTSE 100' },
      { symbol: '^N225', name: 'Nikkei 225' },
      { symbol: '^GDAXI', name: 'DAX' },
      { symbol: '^HSI', name: 'Hang Seng' },
    ],
  },
  metals: {
    label: 'Gold & Silver',
    description: 'Precious metals futures',
    instruments: [
      { symbol: 'GC=F', name: 'Gold' },
      { symbol: 'SI=F', name: 'Silver' },
      { symbol: 'PL=F', name: 'Platinum' },
    ],
  },
  us: {
    label: 'US Market',
    description: 'US equity indices',
    instruments: [
      { symbol: '^GSPC', name: 'S&P 500' },
      { symbol: '^IXIC', name: 'Nasdaq' },
      { symbol: '^DJI', name: 'Dow Jones' },
    ],
  },
  crypto: {
    label: 'Crypto Market',
    description: 'Leading digital assets',
    instruments: [
      { symbol: 'BTC-USD', name: 'Bitcoin' },
      { symbol: 'ETH-USD', name: 'Ethereum' },
      { symbol: 'SOL-USD', name: 'Solana' },
    ],
  },
}

async function fetchQuote(instrument: Instrument): Promise<Quote> {
  const base: Quote = {
    symbol: instrument.symbol,
    name: instrument.name,
    price: null,
    previousClose: null,
    change: null,
    changePercent: null,
    currency: 'USD',
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      instrument.symbol,
    )}?interval=1d&range=2d`
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; AgenticTradingDesk/1.0; +https://vercel.com)',
        Accept: 'application/json',
      },
      // keep data reasonably fresh but avoid hammering the source
      next: { revalidate: 30 },
    })

    if (!res.ok) {
      return { ...base, error: `Upstream ${res.status}` }
    }

    const json = await res.json()
    const meta = json?.chart?.result?.[0]?.meta
    if (!meta) return { ...base, error: 'No data' }

    const price: number | null =
      typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : null
    const previousClose: number | null =
      typeof meta.chartPreviousClose === 'number'
        ? meta.chartPreviousClose
        : typeof meta.previousClose === 'number'
          ? meta.previousClose
          : null

    const change =
      price !== null && previousClose !== null ? price - previousClose : null
    const changePercent =
      change !== null && previousClose ? (change / previousClose) * 100 : null

    return {
      ...base,
      price,
      previousClose,
      change,
      changePercent,
      currency: meta.currency ?? 'USD',
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : 'Fetch failed' }
  }
}

export async function getSegmentQuotes(segment: Segment): Promise<Quote[]> {
  const { instruments } = SEGMENTS[segment]
  return Promise.all(instruments.map(fetchQuote))
}

export async function getAllQuotes(): Promise<Record<Segment, Quote[]>> {
  const segments = Object.keys(SEGMENTS) as Segment[]
  const results = await Promise.all(
    segments.map(async (s) => [s, await getSegmentQuotes(s)] as const),
  )
  return Object.fromEntries(results) as Record<Segment, Quote[]>
}

export function formatQuotesForModel(segment: Segment, quotes: Quote[]): string {
  const header = SEGMENTS[segment].label
  const lines = quotes.map((q) => {
    if (q.price === null) return `- ${q.name} (${q.symbol}): data unavailable`
    const pct =
      q.changePercent !== null ? `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%` : 'n/a'
    return `- ${q.name} (${q.symbol}): ${q.price.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} ${q.currency}, session change ${pct}`
  })
  return `${header} live quotes:\n${lines.join('\n')}`
}
