import { describe, expect, it } from 'vitest'
import { PLATFORM_LIMITS } from '@/lib/trading/limits'
import { dec } from '@/lib/trading/money'
import { checkHalts, evaluateIntent } from '@/lib/trading/risk'
import { adjustedCodes, buy, context, failedCodes, NOW, portfolio, quote, sell } from './helpers'

const LIVE_OK = { entitled: true, brokerConnected: true, brokerCanTrade: true, twoFactorEnabled: true, riskAcknowledged: true }

describe('evaluateIntent — hard gates', () => {
  it('approves an ordinary paper buy and prices it inside the collar', () => {
    const d = evaluateIntent(buy(1_000), context())
    expect(d.approved).toBe(true)
    expect(d.ticket).not.toBeNull()
    // ask 60,010 + 40 bps = 60,250.04
    expect(d.ticket!.limitPrice).toBe('60250.04')
    expect(dec(d.ticket!.baseSize).times(d.ticket!.limitPrice).lte(1_000)).toBe(true)
    expect(failedCodes(d.checks)).toEqual([])
  })

  it('rejects everything when the platform kill switch is on', () => {
    const d = evaluateIntent(buy(1_000), context({ platformKillSwitch: true }))
    expect(d.approved).toBe(false)
    expect(d.ticket).toBeNull()
    expect(failedCodes(d.checks)).toEqual(['KILL_SWITCH'])
    const s = evaluateIntent(sell(500, 'BTC-USD', true), context({ platformKillSwitch: true, portfolio: portfolio(0, { 'BTC-USD': { qty: 0.1, cost: 5_000 } }) }))
    expect(s.approved).toBe(false)
  })

  it.each(['paused', 'halted'] as const)('rejects when the agent is %s', (status) => {
    const d = evaluateIntent(buy(1_000), context({ status }))
    expect(failedCodes(d.checks)).toEqual(['AGENT_STATUS'])
  })

  it('rejects a live order unless every prerequisite holds', () => {
    for (const missing of Object.keys(LIVE_OK) as (keyof typeof LIVE_OK)[]) {
      const d = evaluateIntent(buy(1_000), context({ ledger: 'live', mode: 'auto', live: { ...LIVE_OK, [missing]: false }, exchangeAvailable: { usd: dec(10_000), base: {} } }))
      expect(d.approved, missing).toBe(false)
      expect(failedCodes(d.checks)).toEqual(['LIVE_PREREQUISITES'])
    }
    const ok = evaluateIntent(buy(1_000), context({ ledger: 'live', mode: 'auto', live: LIVE_OK, exchangeAvailable: { usd: dec(10_000), base: {} } }))
    expect(ok.approved).toBe(true)
  })

  it('never lets a paper-mode agent touch the live ledger, or the reverse', () => {
    expect(evaluateIntent(buy(1_000), context({ ledger: 'live', mode: 'paper', live: LIVE_OK })).approved).toBe(false)
    expect(evaluateIntent(buy(1_000), context({ ledger: 'paper', mode: 'auto' })).approved).toBe(false)
  })

  it('rejects a product outside the universe or the platform allow-list', () => {
    expect(failedCodes(evaluateIntent(buy(1_000, 'DOGE-USD'), context()).checks)).toEqual(['PRODUCT_ALLOWED'])
    const narrowed = context({ policyOver: { universe: ['ETH-USD'] } })
    expect(failedCodes(evaluateIntent(buy(1_000, 'BTC-USD'), narrowed).checks)).toEqual(['PRODUCT_ALLOWED'])
  })

  it('rejects an untradable or unknown product', () => {
    const c = context()
    c.products['BTC-USD'] = { ...c.products['BTC-USD']!, tradable: false, untradableReason: 'BTC-USD is in cancel-only mode.' }
    const d = evaluateIntent(buy(1_000), c)
    expect(failedCodes(d.checks)).toEqual(['PRODUCT_TRADABLE'])
    expect(d.checks.at(-1)!.message).toContain('cancel-only')
    const c2 = context()
    delete c2.products['BTC-USD']
    expect(failedCodes(evaluateIntent(buy(1_000), c2).checks)).toEqual(['PRODUCT_TRADABLE'])
  })

  it('rejects a stale, missing, future-dated, crossed or wide quote', () => {
    const stale = context({ quotes: { 'BTC-USD': quote(59_990, 60_010, { asOf: new Date(NOW.getTime() - (PLATFORM_LIMITS.maxQuoteAgeSeconds + 1) * 1000) }) } })
    expect(failedCodes(evaluateIntent(buy(1_000), stale).checks)).toEqual(['QUOTE_FRESH'])
    expect(failedCodes(evaluateIntent(buy(1_000), context({ quotes: {} })).checks)).toEqual(['QUOTE_FRESH'])
    const future = context({ quotes: { 'BTC-USD': quote(59_990, 60_010, { asOf: new Date(NOW.getTime() + 60_000) }) } })
    expect(failedCodes(evaluateIntent(buy(1_000), future).checks)).toEqual(['QUOTE_FRESH'])
    const crossed = context({ quotes: { 'BTC-USD': quote(60_010, 59_990) } })
    expect(failedCodes(evaluateIntent(buy(1_000), crossed).checks)).toEqual(['QUOTE_SANE'])
    const wide = context({ quotes: { 'BTC-USD': quote(58_000, 60_010) } })
    expect(failedCodes(evaluateIntent(buy(1_000), wide).checks)).toEqual(['QUOTE_SANE'])
  })

  it('rejects when signals are stale', () => {
    const c = context({ signalAsOf: new Date(NOW.getTime() - (PLATFORM_LIMITS.maxSignalAgeHours + 1) * 3_600_000) })
    expect(failedCodes(evaluateIntent(buy(1_000), c).checks)).toEqual(['SIGNAL_FRESH'])
  })

  it('pauses buys after an extreme 24h move, in either direction', () => {
    for (const change of [PLATFORM_LIMITS.volatilityHaltPct + 1, -(PLATFORM_LIMITS.volatilityHaltPct + 1)]) {
      const c = context({ quotes: { 'BTC-USD': quote(59_990, 60_010, { change24hPct: change }) } })
      expect(failedCodes(evaluateIntent(buy(1_000), c).checks)).toEqual(['VOLATILITY_HALT'])
    }
  })

  it('enforces the per-product cooldown and the daily buy count', () => {
    const cooling = context({ lastBuyAt: { 'BTC-USD': new Date(NOW.getTime() - 10 * 60_000) } })
    expect(failedCodes(evaluateIntent(buy(1_000), cooling).checks)).toEqual(['COOLDOWN'])
    const c = context()
    c.today.buyCount = c.policy.maxTradesPerDay
    expect(failedCodes(evaluateIntent(buy(1_000), c).checks)).toEqual(['DAILY_TRADE_COUNT'])
  })
})

describe('evaluateIntent — sizing', () => {
  it('shrinks a buy to the largest-order limit', () => {
    const c = context({ policyOver: { maxOrderUsd: '500' } })
    const d = evaluateIntent(buy(5_000), c)
    expect(d.approved).toBe(true)
    expect(adjustedCodes(d.checks)).toContain('ORDER_SIZE_MAX')
    expect(dec(d.ticket!.notionalUsd).lte(500)).toBe(true)
  })

  it('shrinks a buy to the remaining daily turnover and rejects when none is left', () => {
    const c = context({ policyOver: { maxDailyTurnoverUsd: '1000' } })
    c.today.buyTurnoverUsd = dec(700)
    const d = evaluateIntent(buy(900), c)
    expect(adjustedCodes(d.checks)).toContain('DAILY_TURNOVER')
    expect(dec(d.ticket!.notionalUsd).lte(300)).toBe(true)
    c.today.buyTurnoverUsd = dec(1_000)
    expect(failedCodes(evaluateIntent(buy(900), c).checks)).toEqual(['DAILY_TURNOVER'])
  })

  it('shrinks a buy to the position limit and rejects when the position is full', () => {
    // 30% of 10,000 equity = 3,000; BTC position already worth 0.04 * 60,000 = 2,400
    const c = context({ portfolio: portfolio(7_600, { 'BTC-USD': { qty: 0.04, cost: 2_400 } }), policyOver: { maxOrderUsd: '5000' } })
    const d = evaluateIntent(buy(2_000), c)
    expect(adjustedCodes(d.checks)).toContain('POSITION_LIMIT')
    expect(dec(d.ticket!.notionalUsd).lte(600)).toBe(true)
    const full = context({ portfolio: portfolio(7_000, { 'BTC-USD': { qty: 0.05, cost: 3_000 } }) })
    expect(failedCodes(evaluateIntent(buy(500), full).checks)).toEqual(['POSITION_LIMIT'])
  })

  it('shrinks a buy to the exposure limit across all positions', () => {
    // exposure limit 60% of 10,000 = 6,000; already 0.05 BTC (3,000) + 1.5 ETH (2,550) = 5,550
    const c = context({
      portfolio: portfolio(4_450, { 'BTC-USD': { qty: 0.05, cost: 3_000 }, 'ETH-USD': { qty: 1.5, cost: 2_550 } }),
      policyOver: { maxPositionPct: 60, maxOrderUsd: '5000' },
    })
    const d = evaluateIntent(buy(2_000, 'ETH-USD'), c)
    expect(adjustedCodes(d.checks)).toContain('EXPOSURE_LIMIT')
    expect(dec(d.ticket!.notionalUsd).lte(450)).toBe(true)
  })

  it('never spends more than the agent has in cash, fee included', () => {
    const c = context({ portfolio: portfolio(300), policyOver: { maxPositionPct: 100, maxExposurePct: 100 } })
    const d = evaluateIntent(buy(1_000), c)
    expect(adjustedCodes(d.checks)).toContain('CASH_AVAILABLE')
    const worstCost = dec(d.ticket!.baseSize).times(d.ticket!.limitPrice).times(dec(1).plus(c.feeRate))
    expect(worstCost.lte(300)).toBe(true)
    const broke = context({ portfolio: portfolio(0) })
    expect(failedCodes(evaluateIntent(buy(1_000), broke).checks)).toContain('POSITION_LIMIT')
  })

  it('caps a live buy at the USD actually available on the exchange', () => {
    const c = context({ ledger: 'live', mode: 'auto', live: LIVE_OK, exchangeAvailable: { usd: dec(200), base: {} } })
    const d = evaluateIntent(buy(1_000), c)
    expect(adjustedCodes(d.checks)).toContain('EXCHANGE_BALANCE')
    expect(dec(d.ticket!.notionalUsd).times(dec(1).plus(c.feeRate)).lte(200)).toBe(true)
    const none = context({ ledger: 'live', mode: 'auto', live: LIVE_OK, exchangeAvailable: { usd: dec(0), base: {} } })
    expect(failedCodes(evaluateIntent(buy(1_000), none).checks)).toEqual(['EXCHANGE_BALANCE'])
    const unknown = context({ ledger: 'live', mode: 'auto', live: LIVE_OK })
    expect(failedCodes(evaluateIntent(buy(1_000), unknown).checks)).toEqual(['EXCHANGE_BALANCE'])
  })

  it('rejects an order that ends up below the minimum', () => {
    const c = context({ portfolio: portfolio(8), policyOver: { maxPositionPct: 100, maxExposurePct: 100 } })
    expect(failedCodes(evaluateIntent(buy(1_000), c).checks)).toEqual(['ORDER_SIZE_MIN'])
    expect(failedCodes(evaluateIntent(buy(0), context()).checks)).toEqual(['ORDER_SIZE_MIN'])
    expect(failedCodes(evaluateIntent(buy(-50), context()).checks)).toEqual(['ORDER_SIZE_MIN'])
  })

  it('puts sizes and prices on the exchange increments', () => {
    const c = context()
    c.products['BTC-USD'] = { ...c.products['BTC-USD']!, baseIncrement: '0.0001', priceIncrement: '0.5' }
    const d = evaluateIntent(buy(1_000), c)
    expect(d.ticket!.baseSize).toMatch(/^\d+\.\d{4}$/)
    expect(dec(d.ticket!.limitPrice).mod('0.5').eq(0)).toBe(true)
  })
})

describe('evaluateIntent — sells', () => {
  const holding = () => context({ portfolio: portfolio(1_000, { 'BTC-USD': { qty: 0.05, cost: 3_000 } }) })

  it('sells only what the agent holds', () => {
    expect(failedCodes(evaluateIntent(sell(500), context()).checks)).toEqual(['POSITION_AVAILABLE'])
    const d = evaluateIntent(sell(999_999), holding())
    expect(d.approved).toBe(true)
    expect(adjustedCodes(d.checks)).toContain('POSITION_AVAILABLE')
    expect(d.ticket!.baseSize).toBe('0.05000000')
  })

  it('closes the whole position on a full exit and prices below the bid inside the collar', () => {
    const d = evaluateIntent(sell(1, 'BTC-USD', true), holding())
    expect(d.approved).toBe(true)
    expect(d.ticket!.baseSize).toBe('0.05000000')
    // bid 59,990 - 40 bps = 59,750.04
    expect(d.ticket!.limitPrice).toBe('59750.04')
  })

  it('lets exits through limits that exist to stop over-trading', () => {
    const c = holding()
    c.today.buyCount = 999
    c.today.buyTurnoverUsd = dec(999_999)
    c.lastBuyAt['BTC-USD'] = NOW
    c.quotes['BTC-USD'] = quote(59_990, 60_010, { change24hPct: -35 })
    expect(evaluateIntent(sell(1, 'BTC-USD', true), c).approved).toBe(true)
  })

  it('allows a user-driven exit of a removed product even when signals are stale', () => {
    const c = context({
      portfolio: portfolio(1_000, { 'BTC-USD': { qty: 0.05, cost: 3_000 } }),
      policyOver: { universe: ['ETH-USD'] },
      signalAsOf: new Date(NOW.getTime() - 48 * 3_600_000),
    })
    expect(evaluateIntent(sell(1, 'BTC-USD', true), c).approved).toBe(true)
    // ...but a signal-driven trim on stale signals is refused
    const stale = context({ portfolio: portfolio(1_000, { 'BTC-USD': { qty: 0.05, cost: 3_000 } }), signalAsOf: new Date(NOW.getTime() - 48 * 3_600_000) })
    expect(failedCodes(evaluateIntent(sell(500), stale).checks)).toEqual(['SIGNAL_FRESH'])
  })

  it('caps a live sell at what the exchange has available', () => {
    const base = { ledger: 'live' as const, mode: 'auto' as const, live: LIVE_OK, portfolio: portfolio(1_000, { 'BTC-USD': { qty: 0.05, cost: 3_000 } }) }
    const d = evaluateIntent(sell(1, 'BTC-USD', true), context({ ...base, exchangeAvailable: { usd: dec(0), base: { 'BTC-USD': dec('0.02') } } }))
    expect(adjustedCodes(d.checks)).toContain('EXCHANGE_BALANCE')
    expect(d.ticket!.baseSize).toBe('0.02000000')
    const gone = evaluateIntent(sell(1, 'BTC-USD', true), context({ ...base, exchangeAvailable: { usd: dec(0), base: {} } }))
    expect(failedCodes(gone.checks)).toEqual(['EXCHANGE_BALANCE'])
  })

  it('leaves dust alone', () => {
    const c = context({ portfolio: portfolio(1_000, { 'BTC-USD': { qty: 0.000001, cost: 0.06 } }) })
    expect(failedCodes(evaluateIntent(sell(1, 'BTC-USD', true), c).checks)).toEqual(['ORDER_SIZE_MIN'])
  })
})

describe('checkHalts', () => {
  const policy = { dailyLossLimitPct: 3, maxDrawdownPct: 15 }
  it('is quiet inside the limits', () => {
    expect(checkHalts({ equityUsd: dec(9_800), dayStartEquityUsd: dec(10_000), peakEquityUsd: dec(10_500), policy })).toBeNull()
  })
  it('trips on the daily loss limit', () => {
    expect(checkHalts({ equityUsd: dec(9_700), dayStartEquityUsd: dec(10_000), peakEquityUsd: dec(10_000), policy })).toBe('DAILY_LOSS_LIMIT')
  })
  it('trips on drawdown from the peak', () => {
    expect(checkHalts({ equityUsd: dec(8_500), dayStartEquityUsd: dec(8_600), peakEquityUsd: dec(10_000), policy })).toBe('MAX_DRAWDOWN')
  })
  it('does not divide by zero on an empty book', () => {
    expect(checkHalts({ equityUsd: dec(0), dayStartEquityUsd: dec(0), peakEquityUsd: dec(0), policy })).toBeNull()
  })
})
