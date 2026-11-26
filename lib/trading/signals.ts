/**
 * Signals: a transparent quant score per asset, optionally tilted by the AI
 * desk's view. The tilt is bounded, so a wrong, manipulated or hallucinated
 * model output can move a conviction by at most AI_MAX_TILT — never flip a
 * strong downtrend into a buy.
 */
import type { Features } from './indicators'
import type { AssetSignal, Regime, SignalWord } from './types'

/** The most the AI view can move a conviction away from the quant score. */
export const AI_MAX_TILT = 0.35

/** Scores above this read BULLISH, below its negative BEARISH. */
export const SIGNAL_WORD_THRESHOLD = 0.15

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * Trend + risk-adjusted momentum in [-1, 1].
 *
 * - Trend: where the last close sits against its 20, 50 and 200-session means,
 *   each squashed with tanh at a scale typical for that horizon.
 * - Momentum: the 30-session return divided by what a 30-session move
 *   "normally" is at current volatility (a z-score), squashed with tanh.
 * - A stretched RSI trims the score; a deep drawdown caps it.
 *
 * This is a plain trend-following heuristic. It is here to be predictable and
 * explainable, not to be clever.
 */
export function quantScore(f: Features): number {
  const trendParts: number[] = []
  if (f.sma20Dist !== null) trendParts.push(Math.tanh(f.sma20Dist / 0.05))
  if (f.sma50Dist !== null) trendParts.push(Math.tanh(f.sma50Dist / 0.1))
  if (f.sma200Dist !== null) trendParts.push(Math.tanh(f.sma200Dist / 0.2))
  const trend = trendParts.length ? avg(trendParts) : 0

  let momentum = 0
  if (f.ret30d !== null && f.dailyVol30d !== null && f.dailyVol30d > 0) {
    const z = f.ret30d / (f.dailyVol30d * Math.sqrt(30))
    momentum = Math.tanh(z / 1.5)
  } else if (f.ret7d !== null) {
    momentum = Math.tanh(f.ret7d / 0.1)
  }

  let score = 0.5 * trend + 0.5 * momentum
  if (f.rsi14 !== null) {
    if (f.rsi14 > 78) score -= 0.15
    else if (f.rsi14 < 22) score += 0.1
  }
  if (f.drawdown90d !== null && f.drawdown90d < -0.35) score = Math.min(score, 0.3)
  return round3(clamp(score, -1, 1))
}

/** Quant score tilted toward the AI view by at most AI_MAX_TILT. */
export function blendConviction(quant: number, aiView: number | null): number {
  if (aiView === null || !Number.isFinite(aiView)) return round3(clamp(quant, -1, 1))
  const tilt = clamp(clamp(aiView, -1, 1) - quant, -AI_MAX_TILT, AI_MAX_TILT)
  return round3(clamp(quant + tilt, -1, 1))
}

export function signalWord(score: number): SignalWord {
  if (score > SIGNAL_WORD_THRESHOLD) return 'BULLISH'
  if (score < -SIGNAL_WORD_THRESHOLD) return 'BEARISH'
  return 'NEUTRAL'
}

export function buildAssetSignal(productId: string, features: Features, ai: { view: number; rationale: string } | null): AssetSignal {
  const quant = quantScore(features)
  const conviction = blendConviction(quant, ai?.view ?? null)
  return {
    productId,
    quantScore: quant,
    aiView: ai ? round3(clamp(ai.view, -1, 1)) : null,
    conviction,
    word: signalWord(conviction),
    rationale: ai?.rationale ?? describeFeatures(features),
  }
}

/** A one-line, numbers-only explanation used when the AI desk did not run. */
export function describeFeatures(f: Features): string {
  const pct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`)
  const parts = [`30-session return ${pct(f.ret30d)}`, `vs 50-session mean ${pct(f.sma50Dist)}`]
  if (f.rsi14 !== null) parts.push(`RSI ${f.rsi14.toFixed(0)}`)
  if (f.drawdown90d !== null) parts.push(`${pct(f.drawdown90d)} from 90-session high`)
  return `Rules-based read: ${parts.join(', ')}.`
}

export interface RegimeInputs {
  /** Quant scores of broad equity indices (US and global). */
  equityScores: number[]
  /** Last VIX close, when available. */
  vix: number | null
}

/**
 * Deterministic market regime. Used as-is when the AI desk is unavailable, and
 * as the anchor the desk's regime may differ from by one step at most.
 */
export function quantRegime({ equityScores, vix }: RegimeInputs): Regime {
  const equity = equityScores.length ? avg(equityScores) : 0
  if ((vix !== null && vix >= 30) || equity < -0.4) return 'risk_off'
  if (equity > 0.25 && (vix === null || vix < 22)) return 'risk_on'
  return 'neutral'
}

const REGIME_ORDER: Regime[] = ['risk_off', 'neutral', 'risk_on']

/** The AI regime, limited to one step away from the quant regime. */
export function boundRegime(quant: Regime, ai: Regime | null): Regime {
  if (!ai) return quant
  const q = REGIME_ORDER.indexOf(quant)
  const a = REGIME_ORDER.indexOf(ai)
  return REGIME_ORDER[clamp(a, q - 1, q + 1)]!
}

/** Share of the exposure limit the agent may use in each regime. */
export const REGIME_EXPOSURE_SCALE: Record<Regime, number> = {
  risk_on: 1,
  neutral: 0.75,
  risk_off: 0.4,
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
