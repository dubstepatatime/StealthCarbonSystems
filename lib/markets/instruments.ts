/**
 * The instruments the desk watches. This list is the only place a ticker is
 * written down: providers are never handed a symbol from a request.
 */
import type { MarketSource, Segment } from './types'

export interface Instrument {
  id: string
  name: string
  segment: Segment | 'macro'
  source: MarketSource
  /** The symbol as the source writes it. */
  symbol: string
  currency: string
  decimals: number
  /** A Coinbase spot product the agent may trade. */
  tradable?: boolean
  /** Coinbase Derivatives contract root used when the primary source is down. */
  fallbackFutureRoot?: string
}

export const INSTRUMENTS: Instrument[] = [
  // US
  { id: 'spx', name: 'S&P 500', segment: 'us', source: 'yahoo', symbol: '^GSPC', currency: 'USD', decimals: 2 },
  { id: 'ixic', name: 'Nasdaq Composite', segment: 'us', source: 'yahoo', symbol: '^IXIC', currency: 'USD', decimals: 2 },
  { id: 'dji', name: 'Dow Jones', segment: 'us', source: 'yahoo', symbol: '^DJI', currency: 'USD', decimals: 2 },
  { id: 'rut', name: 'Russell 2000', segment: 'us', source: 'yahoo', symbol: '^RUT', currency: 'USD', decimals: 2 },
  { id: 'vix', name: 'VIX volatility', segment: 'us', source: 'yahoo', symbol: '^VIX', currency: 'USD', decimals: 2 },
  // Global
  { id: 'ftse', name: 'FTSE 100', segment: 'global', source: 'yahoo', symbol: '^FTSE', currency: 'GBP', decimals: 2 },
  { id: 'dax', name: 'DAX', segment: 'global', source: 'yahoo', symbol: '^GDAXI', currency: 'EUR', decimals: 2 },
  { id: 'sx5e', name: 'Euro Stoxx 50', segment: 'global', source: 'yahoo', symbol: '^STOXX50E', currency: 'EUR', decimals: 2 },
  { id: 'n225', name: 'Nikkei 225', segment: 'global', source: 'yahoo', symbol: '^N225', currency: 'JPY', decimals: 2 },
  { id: 'hsi', name: 'Hang Seng', segment: 'global', source: 'yahoo', symbol: '^HSI', currency: 'HKD', decimals: 2 },
  { id: 'ssec', name: 'Shanghai Composite', segment: 'global', source: 'yahoo', symbol: '000001.SS', currency: 'CNY', decimals: 2 },
  // Crypto
  { id: 'btc', name: 'Bitcoin', segment: 'crypto', source: 'coinbase', symbol: 'BTC-USD', currency: 'USD', decimals: 2, tradable: true },
  { id: 'eth', name: 'Ethereum', segment: 'crypto', source: 'coinbase', symbol: 'ETH-USD', currency: 'USD', decimals: 2, tradable: true },
  { id: 'sol', name: 'Solana', segment: 'crypto', source: 'coinbase', symbol: 'SOL-USD', currency: 'USD', decimals: 2, tradable: true },
  { id: 'xrp', name: 'XRP', segment: 'crypto', source: 'coinbase', symbol: 'XRP-USD', currency: 'USD', decimals: 4 },
  // Gold and silver
  { id: 'gold', name: 'Gold', segment: 'metals', source: 'yahoo', symbol: 'GC=F', currency: 'USD', decimals: 2, fallbackFutureRoot: 'CDEGLD' },
  { id: 'silver', name: 'Silver', segment: 'metals', source: 'yahoo', symbol: 'SI=F', currency: 'USD', decimals: 3, fallbackFutureRoot: 'CDESIL' },
  { id: 'platinum', name: 'Platinum', segment: 'metals', source: 'yahoo', symbol: 'PL=F', currency: 'USD', decimals: 2, fallbackFutureRoot: 'CDEPT' },
  { id: 'paxg', name: 'PAX Gold', segment: 'metals', source: 'coinbase', symbol: 'PAXG-USD', currency: 'USD', decimals: 2, tradable: true },
  // Macro context for the desk
  { id: 'dxy', name: 'US Dollar Index', segment: 'macro', source: 'yahoo', symbol: 'DX-Y.NYB', currency: 'USD', decimals: 2 },
  { id: 'tnx', name: 'US 10-year yield', segment: 'macro', source: 'yahoo', symbol: '^TNX', currency: 'USD', decimals: 3 },
  { id: 'wti', name: 'WTI crude', segment: 'macro', source: 'yahoo', symbol: 'CL=F', currency: 'USD', decimals: 2 },
]

export const instrumentById = (id: string): Instrument | undefined => INSTRUMENTS.find((i) => i.id === id)
export const instrumentBySymbol = (symbol: string): Instrument | undefined => INSTRUMENTS.find((i) => i.symbol === symbol)
export const instrumentsBySource = (source: MarketSource): Instrument[] => INSTRUMENTS.filter((i) => i.source === source)
