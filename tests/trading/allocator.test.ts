import { describe, expect, it } from 'vitest'
import { ENTRY_THRESHOLD, planRebalance, targetWeights, valuePortfolio } from '@/lib/trading/allocator'
import { defaultPolicy } from '@/lib/trading/limits'
import { dec } from '@/lib/trading/money'
import { portfolio } from './helpers'

const policy = defaultPolicy('balanced', 10_000) // exposure 60%, position 30%, band 4%
const mids = { 'BTC-USD': dec(60_000), 'ETH-USD': dec(1_700), 'SOL-USD': dec(70), 'PAXG-USD': dec(3_550) }
const none = {}

describe('targetWeights', () => {
  it('stays in cash without conviction', () => {
    const w = targetWeights({ convictions: {}, regime: 'risk_on', policy, currentWeights: none })
    expect(Object.values(w).every((v) => v === 0)).toBe(true)
  })

  it('scales with conviction up to the per-asset cap', () => {
    const w = targetWeights({ convictions: { 'BTC-USD': 1, 'ETH-USD': 0.55 }, regime: 'risk_on', policy, currentWeights: none })
    expect(w['BTC-USD']).toBeCloseTo(0.3)
    expect(w['ETH-USD']).toBeCloseTo(0.15)
    expect(w['SOL-USD']).toBe(0)
  })

  it('never exceeds the exposure limit, scaled down by the regime', () => {
    const all = { 'BTC-USD': 1, 'ETH-USD': 1, 'SOL-USD': 1, 'PAXG-USD': 1 }
    for (const [regime, limit] of [['risk_on', 0.6], ['neutral', 0.45], ['risk_off', 0.24]] as const) {
      const w = targetWeights({ convictions: all, regime, policy, currentWeights: none })
      const total = Object.values(w).reduce((a, b) => a + b, 0)
      expect(total).toBeLessThanOrEqual(limit + 1e-9)
      expect(total).toBeGreaterThan(limit - 0.001)
    }
  })

  it('exits on negative conviction, holds on a merely weak one', () => {
    const held = { 'BTC-USD': 0.2 }
    expect(targetWeights({ convictions: { 'BTC-USD': -0.01 }, regime: 'neutral', policy, currentWeights: held })['BTC-USD']).toBe(0)
    expect(targetWeights({ convictions: { 'BTC-USD': ENTRY_THRESHOLD / 2 }, regime: 'risk_on', policy, currentWeights: held })['BTC-USD']).toBeCloseTo(0.2)
    // ...but a weak signal does not open a position
    expect(targetWeights({ convictions: { 'BTC-USD': ENTRY_THRESHOLD / 2 }, regime: 'risk_on', policy, currentWeights: none })['BTC-USD']).toBe(0)
  })

  it('treats garbage convictions as no position', () => {
    const w = targetWeights({ convictions: { 'BTC-USD': Number.NaN, 'ETH-USD': Number.POSITIVE_INFINITY }, regime: 'risk_on', policy, currentWeights: none })
    expect(w['BTC-USD']).toBe(0)
    expect(w['ETH-USD']).toBeLessThanOrEqual(0.3)
  })

  it('ignores products outside the universe', () => {
    const w = targetWeights({ convictions: { 'DOGE-USD': 1 }, regime: 'risk_on', policy, currentWeights: none })
    expect(w['DOGE-USD']).toBeUndefined()
  })
})

describe('planRebalance', () => {
  it('buys toward target from cash, largest first', () => {
    const intents = planRebalance({ targets: { 'BTC-USD': 0.3, 'ETH-USD': 0.15 }, portfolio: portfolio(10_000), mids, policy })
    expect(intents.map((i) => `${i.side} ${i.productId} ${i.notionalUsd.toFixed(0)}`)).toEqual(['BUY BTC-USD 3000', 'BUY ETH-USD 1500'])
  })

  it('does nothing inside the rebalance band', () => {
    const pf = portfolio(7_100, { 'BTC-USD': { qty: 0.0483333, cost: 2_900 } }) // ~29% vs 30% target
    expect(planRebalance({ targets: { 'BTC-USD': 0.3 }, portfolio: pf, mids, policy })).toEqual([])
  })

  it('exits fully when the target is zero, regardless of the band, and sells before it buys', () => {
    const pf = portfolio(9_800, { 'SOL-USD': { qty: 2.857142, cost: 200 } }) // ~2% position
    const intents = planRebalance({ targets: { 'SOL-USD': 0, 'BTC-USD': 0.3 }, portfolio: pf, mids, policy })
    expect(intents[0]).toMatchObject({ side: 'SELL', productId: 'SOL-USD', closePosition: true })
    expect(intents[1]).toMatchObject({ side: 'BUY', productId: 'BTC-USD' })
  })

  it('closes a position whose product left the universe', () => {
    const narrowed = { ...policy, universe: ['BTC-USD'] }
    const pf = portfolio(8_300, { 'ETH-USD': { qty: 1, cost: 1_700 } })
    const intents = planRebalance({ targets: {}, portfolio: pf, mids, policy: narrowed })
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ side: 'SELL', productId: 'ETH-USD', closePosition: true })
    expect(intents[0]!.reason).toContain('removed from your universe')
  })

  it('trims an overweight position', () => {
    const pf = portfolio(5_000, { 'BTC-USD': { qty: 0.0833333, cost: 5_000 } }) // 50% vs 30%
    const intents = planRebalance({ targets: { 'BTC-USD': 0.3 }, portfolio: pf, mids, policy })
    expect(intents).toHaveLength(1)
    expect(intents[0]!.side).toBe('SELL')
    expect(intents[0]!.closePosition).toBeUndefined()
    expect(Number(intents[0]!.notionalUsd.toFixed(0))).toBeCloseTo(2_000, -1)
  })

  it('skips products it cannot price and reports them', () => {
    const pf = portfolio(5_000, { 'BTC-USD': { qty: 0.05, cost: 3_000 } })
    expect(planRebalance({ targets: { 'BTC-USD': 0 }, portfolio: pf, mids: {}, policy })).toEqual([])
    expect(valuePortfolio(pf, {}).unpriced).toEqual(['BTC-USD'])
  })

  it('does nothing with an empty book', () => {
    expect(planRebalance({ targets: { 'BTC-USD': 0.3 }, portfolio: portfolio(0), mids, policy })).toEqual([])
  })
})
