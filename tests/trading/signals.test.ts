import { describe, expect, it } from 'vitest'
import { computeFeatures, rsi, simpleReturn, sma, type Candle } from '@/lib/trading/indicators'
import { AI_MAX_TILT, blendConviction, boundRegime, buildAssetSignal, quantRegime, quantScore, signalWord } from '@/lib/trading/signals'

const series = (n: number, f: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = f(i)
    return { t: 1_700_000_000 + i * 86_400, o: c, h: c * 1.01, l: c * 0.99, c, v: 1 }
  })
// deterministic wobble so volatility is never zero
const wobble = (i: number) => 1 + 0.01 * Math.sin(i * 1.7)
const up = series(260, (i) => 100 * 1.004 ** i * wobble(i))
const down = series(260, (i) => 100 * 0.996 ** i * wobble(i))
const flat = series(260, (i) => 100 * wobble(i))

describe('indicators', () => {
  it('computes the basics', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5)
    expect(sma([1, 2], 3)).toBeNull()
    expect(simpleReturn([100, 110], 1)).toBeCloseTo(0.1)
    expect(simpleReturn([100], 1)).toBeNull()
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 + i))).toBe(100)
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 - i))).toBe(0)
  })

  it('returns null features without history and ignores bad candles', () => {
    expect(computeFeatures([])).toBeNull()
    const dirty = [...up, { t: up.at(-1)!.t + 86_400, o: 1, h: 1, l: 1, c: Number.NaN, v: 0 }]
    expect(computeFeatures(dirty)!.last).toBe(up.at(-1)!.c)
  })

  it('sorts candles by time before reading them', () => {
    expect(computeFeatures([...up].reverse())!.last).toBe(up.at(-1)!.c)
  })
})

describe('quantScore', () => {
  it('is positive in an uptrend, negative in a downtrend, near zero when flat', () => {
    expect(quantScore(computeFeatures(up)!)).toBeGreaterThan(0.4)
    expect(quantScore(computeFeatures(down)!)).toBeLessThan(-0.4)
    expect(Math.abs(quantScore(computeFeatures(flat)!))).toBeLessThan(0.2)
  })

  it('stays inside [-1, 1] on extreme inputs', () => {
    const moon = series(260, (i) => 100 * 1.2 ** i)
    const crash = series(260, (i) => 100 * 0.8 ** i + 1e-9)
    for (const s of [moon, crash]) {
      const q = quantScore(computeFeatures(s)!)
      expect(q).toBeGreaterThanOrEqual(-1)
      expect(q).toBeLessThanOrEqual(1)
    }
  })

  it('caps the score after a deep drawdown', () => {
    const f = { ...computeFeatures(up)!, drawdown90d: -0.5 }
    expect(quantScore(f)).toBeLessThanOrEqual(0.3)
  })
})

describe('blendConviction', () => {
  it('equals the quant score when there is no AI view', () => {
    expect(blendConviction(0.42, null)).toBe(0.42)
    expect(blendConviction(0.42, Number.NaN)).toBe(0.42)
  })

  it('lets the AI view tilt the score by a bounded amount only', () => {
    expect(blendConviction(-0.6, 1)).toBeCloseTo(-0.6 + AI_MAX_TILT)
    expect(blendConviction(0.6, -1)).toBeCloseTo(0.6 - AI_MAX_TILT)
    expect(blendConviction(0.2, 0.3)).toBeCloseTo(0.3)
    // an absurd or hostile model output cannot escape the range
    expect(blendConviction(0.9, 1e9)).toBeLessThanOrEqual(1)
    expect(blendConviction(-0.9, -1e9)).toBeGreaterThanOrEqual(-1)
    // a strong downtrend can never be turned into a buy by the model
    expect(blendConviction(-0.5, 1)).toBeLessThan(0)
  })

  it('labels signals', () => {
    expect(signalWord(0.5)).toBe('BULLISH')
    expect(signalWord(-0.5)).toBe('BEARISH')
    expect(signalWord(0.05)).toBe('NEUTRAL')
    const s = buildAssetSignal('BTC-USD', computeFeatures(up)!, null)
    expect(s.aiView).toBeNull()
    expect(s.conviction).toBe(s.quantScore)
    expect(s.rationale).toContain('Rules-based read')
  })
})

describe('regime', () => {
  it('reads risk-off on a volatility spike or broad weakness', () => {
    expect(quantRegime({ equityScores: [0.5, 0.6], vix: 34 })).toBe('risk_off')
    expect(quantRegime({ equityScores: [-0.6, -0.5], vix: 18 })).toBe('risk_off')
    expect(quantRegime({ equityScores: [0.5, 0.6], vix: 15 })).toBe('risk_on')
    expect(quantRegime({ equityScores: [0.1], vix: null })).toBe('neutral')
    expect(quantRegime({ equityScores: [], vix: null })).toBe('neutral')
  })

  it('lets the AI move the regime one step at most', () => {
    expect(boundRegime('risk_off', 'risk_on')).toBe('neutral')
    expect(boundRegime('risk_on', 'risk_off')).toBe('neutral')
    expect(boundRegime('neutral', 'risk_on')).toBe('risk_on')
    expect(boundRegime('neutral', null)).toBe('neutral')
  })
})
