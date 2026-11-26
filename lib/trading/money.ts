/**
 * Exact decimal arithmetic for anything that becomes an order.
 *
 * Money and quantities never touch binary floating point: they are `Big`
 * values in memory and decimal strings at every boundary (database, exchange
 * API, JSON). Floats are fine for analytics (returns, volatility, scores) and
 * are kept out of this module.
 */
import Big from 'big.js'

// 30 decimal places of division precision; never print exponent notation for
// the magnitudes we handle (down to satoshis, up to billions of dollars).
Big.DP = 30
Big.NE = -31
Big.PE = 40

export { Big }
export type Decimalish = Big | string | number

export const ZERO = new Big(0)
export const ONE = new Big(1)
export const HUNDRED = new Big(100)
export const BPS = new Big(10_000)

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

/** Parse a decimal. Throws on anything that is not a plain decimal number. */
export function dec(value: Decimalish): Big {
  if (value instanceof Big) return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`)
    return new Big(value)
  }
  const trimmed = value.trim()
  if (!DECIMAL_RE.test(trimmed)) throw new RangeError(`Not a decimal string: "${value}"`)
  return new Big(trimmed)
}

/** Parse a decimal from untrusted input; returns null instead of throwing. */
export function tryDec(value: unknown): Big | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  try {
    return dec(value)
  } catch {
    return null
  }
}

export const minBig = (a: Big, b: Big): Big => (a.lt(b) ? a : b)
export const maxBig = (a: Big, b: Big): Big => (a.gt(b) ? a : b)
export const clampBig = (value: Big, lo: Big, hi: Big): Big => maxBig(lo, minBig(value, hi))

/** Number of decimal places an exchange increment such as "0.00000001" allows. */
export function decimalsOf(increment: Decimalish): number {
  const s = dec(increment).toFixed()
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

/** Round down to a multiple of `increment`. Sizes are always rounded down. */
export function floorTo(value: Big, increment: Decimalish): Big {
  const inc = dec(increment)
  if (inc.lte(0)) throw new RangeError('Increment must be positive')
  return value.div(inc).round(0, Big.roundDown).times(inc)
}

/** Round up to a multiple of `increment`. */
export function ceilTo(value: Big, increment: Decimalish): Big {
  const inc = dec(increment)
  if (inc.lte(0)) throw new RangeError('Increment must be positive')
  return value.div(inc).round(0, Big.roundUp).times(inc)
}

/** Format for an exchange field that must match `increment` exactly. */
export function formatTo(value: Big, increment: Decimalish): string {
  return floorTo(value, increment).toFixed(decimalsOf(increment))
}

/** Canonical storage form: plain decimal, no exponent, no trailing zeros. */
export function toDecimalString(value: Big): string {
  return value.toFixed()
}

/** Dollars and cents, rounded half-up. For display and audit text only. */
export function usd(value: Big): string {
  return value.round(2, Big.roundHalfUp).toFixed(2)
}

/** `pct` percent as a fraction: pctOf(2.5) -> 0.025. */
export function pctOf(pct: number): Big {
  return dec(pct).div(HUNDRED)
}

/** `bps` basis points as a fraction: bpsOf(50) -> 0.005. */
export function bpsOf(bps: number): Big {
  return dec(bps).div(BPS)
}

/** Lossy conversion for analytics and display. Never feed the result back into an order. */
export function toNumber(value: Big): number {
  return Number(value.toFixed())
}
