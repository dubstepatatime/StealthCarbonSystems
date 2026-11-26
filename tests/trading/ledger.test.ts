import { describe, expect, it } from 'vitest'
import { PAPER_TAKER_FEE_BPS, simulateFill } from '@/lib/trading/broker'
import { defaultPolicy, parseRiskPolicy, PLATFORM_LIMITS, RISK_PROFILES, PolicyError } from '@/lib/trading/limits'
import { bpsOf, dec } from '@/lib/trading/money'
import { applyFill, emptyPortfolio, LedgerError } from '@/lib/trading/portfolio'
import type { OrderTicket } from '@/lib/trading/types'
import { quote } from './helpers'

const fee = bpsOf(PAPER_TAKER_FEE_BPS)
const ticket = (side: 'BUY' | 'SELL', baseSize: string, limitPrice: string): OrderTicket => ({ productId: 'BTC-USD', side, baseSize, limitPrice, notionalUsd: dec(baseSize).times(limitPrice).toFixed(2) })

describe('simulateFill', () => {
  it('fills a buy at or below its limit and charges the fee', () => {
    const fill = simulateFill(ticket('BUY', '0.01', '60250.04'), quote(59_990, 60_010), fee)!
    expect(fill.price.lte('60250.04')).toBe(true)
    expect(fill.price.gte(60_010)).toBe(true)
    expect(fill.feeUsd.eq(fill.quoteUsd.times(fee))).toBe(true)
  })
  it('does not fill outside the limit', () => {
    expect(simulateFill(ticket('BUY', '0.01', '60000'), quote(59_990, 60_010), fee)).toBeNull()
    expect(simulateFill(ticket('SELL', '0.01', '60000'), quote(59_990, 60_010), fee)).toBeNull()
  })
  it('fills a sell at or above its limit', () => {
    const fill = simulateFill(ticket('SELL', '0.01', '59750.04'), quote(59_990, 60_010), fee)!
    expect(fill.price.gte('59750.04')).toBe(true)
    expect(fill.price.lte(59_990)).toBe(true)
  })
})

describe('applyFill', () => {
  it('moves cash and quantity on a buy, with the fee in the cost basis', () => {
    const { portfolio, realizedPnlUsd } = applyFill(emptyPortfolio(dec(1_000)), 'BTC-USD', 'BUY', { baseSize: dec('0.01'), price: dec(60_000), quoteUsd: dec(600), feeUsd: dec('7.2') })
    expect(portfolio.cashUsd.toFixed(2)).toBe('392.80')
    expect(portfolio.positions['BTC-USD']!.qty.toFixed()).toBe('0.01')
    expect(portfolio.positions['BTC-USD']!.costUsd.toFixed(2)).toBe('607.20')
    expect(realizedPnlUsd.eq(0)).toBe(true)
  })

  it('realizes profit and loss on a sell and removes an emptied position', () => {
    const bought = applyFill(emptyPortfolio(dec(1_000)), 'BTC-USD', 'BUY', { baseSize: dec('0.01'), price: dec(60_000), quoteUsd: dec(600), feeUsd: dec('7.2') }).portfolio
    const half = applyFill(bought, 'BTC-USD', 'SELL', { baseSize: dec('0.005'), price: dec(66_000), quoteUsd: dec(330), feeUsd: dec('3.96') })
    expect(half.realizedPnlUsd.toFixed(2)).toBe('22.44') // 330 - 3.96 - 303.60
    expect(half.portfolio.positions['BTC-USD']!.costUsd.toFixed(2)).toBe('303.60')
    const rest = applyFill(half.portfolio, 'BTC-USD', 'SELL', { baseSize: dec('0.005'), price: dec(50_000), quoteUsd: dec(250), feeUsd: dec(3) })
    expect(rest.realizedPnlUsd.toFixed(2)).toBe('-56.60')
    expect(rest.portfolio.positions['BTC-USD']).toBeUndefined()
  })

  it('refuses to overdraw cash or oversell a position', () => {
    expect(() => applyFill(emptyPortfolio(dec(100)), 'BTC-USD', 'BUY', { baseSize: dec('0.01'), price: dec(60_000), quoteUsd: dec(600), feeUsd: dec(0) })).toThrow(LedgerError)
    expect(() => applyFill(emptyPortfolio(dec(100)), 'BTC-USD', 'SELL', { baseSize: dec('0.01'), price: dec(60_000), quoteUsd: dec(600), feeUsd: dec(0) })).toThrow(LedgerError)
    expect(() => applyFill(emptyPortfolio(dec(100)), 'BTC-USD', 'BUY', { baseSize: dec(0), price: dec(1), quoteUsd: dec(0), feeUsd: dec(0) })).toThrow(LedgerError)
  })
})

describe('risk policy', () => {
  it('builds a valid default for every profile', () => {
    for (const profile of RISK_PROFILES) for (const capital of [50, 500, 10_000, 100_000]) {
      const p = defaultPolicy(profile, capital)
      expect(() => parseRiskPolicy(p, 100_000), `${profile} ${capital}`).not.toThrow()
    }
  })

  it('rejects values outside the platform limits instead of widening them', () => {
    const base = defaultPolicy('balanced', 1_000)
    const bad: [string, object][] = [
      ['capital above plan', { capitalUsd: '5000' }],
      ['capital below floor', { capitalUsd: '10' }],
      ['order above ceiling', { capitalUsd: '100000', maxOrderUsd: String(PLATFORM_LIMITS.maxOrderUsdCeiling + 1) }],
      ['min order below floor', { minOrderUsd: '1' }],
      ['slippage above ceiling', { maxSlippageBps: PLATFORM_LIMITS.maxSlippageBpsCeiling + 1 }],
      ['loss limit off', { dailyLossLimitPct: 100 }],
      ['unknown product', { universe: ['DOGE-USD'] }],
      ['duplicate product', { universe: ['BTC-USD', 'BTC-USD'] }],
      ['empty universe', { universe: [] }],
      ['position above exposure', { maxExposurePct: 20, maxPositionPct: 50 }],
      ['unknown key', { leverage: 5 }],
      ['non-decimal', { capitalUsd: '1e9' }],
      ['negative', { capitalUsd: '-100' }],
    ]
    for (const [name, over] of bad) expect(() => parseRiskPolicy({ ...base, ...over }, name === 'order above ceiling' ? 100_000 : 2_500), name).toThrow(PolicyError)
  })

  it('ties the largest order to capital', () => {
    const p = parseRiskPolicy({ ...defaultPolicy('balanced', 200), maxOrderUsd: '5000' }, 2_500)
    expect(p.maxOrderUsd).toBe('200')
  })
})
