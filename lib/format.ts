/** Number formatting shared by server and client. A missing value is an em dash, never zero. */
export const DASH = '—'

export function formatPrice(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return DASH
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** Signed percent with a real minus sign: +3.26%, −0.81%. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH
  const abs = Math.abs(value).toFixed(2)
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${abs}%`
}

export const direction = (value: number | null | undefined): 'up' | 'down' | 'flat' => (value == null || value === 0 || !Number.isFinite(value) ? 'flat' : value > 0 ? 'up' : 'down')
export const CARET = { up: '▲', down: '▼', flat: '–' } as const

export const formatUsd = (value: string | number) => `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const formatTime = (iso: string | Date | null | undefined) => (iso ? `${new Date(iso).toISOString().slice(11, 16)} UTC` : DASH)
export const formatDateTime = (iso: string | Date) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`
