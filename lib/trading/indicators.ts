/**
 * Technical indicators over daily closes. Analytics only: plain numbers, no
 * money math. Every function returns null when there is not enough history
 * rather than guessing.
 */

export interface Candle {
  /** Start of the period, unix seconds. */
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface Features {
  last: number
  ret1d: number | null
  ret7d: number | null
  ret30d: number | null
  ret90d: number | null
  /** (last - SMA) / SMA */
  sma20Dist: number | null
  sma50Dist: number | null
  sma200Dist: number | null
  /** Standard deviation of daily log returns over 30 sessions (not annualized). */
  dailyVol30d: number | null
  rsi14: number | null
  /** (last - highest close in 90 sessions) / that high. Zero or negative. */
  drawdown90d: number | null
}

const finite = (n: number) => Number.isFinite(n)

/** Closes in time order, with anything unusable dropped. */
export function closes(candles: Candle[]): number[] {
  return [...candles]
    .sort((a, b) => a.t - b.t)
    .map((c) => c.c)
    .filter((c) => finite(c) && c > 0)
}

export function sma(series: number[], period: number): number | null {
  if (period <= 0 || series.length < period) return null
  let sum = 0
  for (let i = series.length - period; i < series.length; i++) sum += series[i]!
  return sum / period
}

/** Simple return over `sessions` closes. */
export function simpleReturn(series: number[], sessions: number): number | null {
  if (series.length <= sessions) return null
  const then = series[series.length - 1 - sessions]!
  const now = series[series.length - 1]!
  return then > 0 ? now / then - 1 : null
}

/** Sample standard deviation of the last `sessions` daily log returns. */
export function dailyVolatility(series: number[], sessions: number): number | null {
  if (series.length <= sessions) return null
  const rets: number[] = []
  for (let i = series.length - sessions; i < series.length; i++) rets.push(Math.log(series[i]! / series[i - 1]!))
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)
  return Math.sqrt(variance)
}

/** Wilder's RSI. */
export function rsi(series: number[], period = 14): number | null {
  if (series.length <= period) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = series[i]! - series[i - 1]!
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  for (let i = period + 1; i < series.length; i++) {
    const d = series[i]! - series[i - 1]!
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
  }
  if (loss === 0) return gain === 0 ? 50 : 100
  return 100 - 100 / (1 + gain / loss)
}

export function drawdownFromHigh(series: number[], sessions: number): number | null {
  if (series.length === 0) return null
  const window = series.slice(-sessions)
  const high = Math.max(...window)
  const last = series[series.length - 1]!
  return high > 0 ? last / high - 1 : null
}

export function computeFeatures(candles: Candle[]): Features | null {
  const series = closes(candles)
  if (series.length < 2) return null
  const last = series[series.length - 1]!
  const dist = (period: number) => {
    const m = sma(series, period)
    return m === null ? null : last / m - 1
  }
  return {
    last,
    ret1d: simpleReturn(series, 1),
    ret7d: simpleReturn(series, 7),
    ret30d: simpleReturn(series, 30),
    ret90d: simpleReturn(series, 90),
    sma20Dist: dist(20),
    sma50Dist: dist(50),
    sma200Dist: dist(200),
    dailyVol30d: dailyVolatility(series, 30),
    rsi14: rsi(series, 14),
    drawdown90d: drawdownFromHigh(series, 90),
  }
}
