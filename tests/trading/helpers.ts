import { defaultPolicy } from '@/lib/trading/limits'
import { dec, ZERO, type Big } from '@/lib/trading/money'
import type { RiskContext } from '@/lib/trading/risk'
import type { AgentPortfolio, ProductSpec, RiskPolicy, TopOfBook, TradeIntent } from '@/lib/trading/types'

export const NOW = new Date('2026-11-26T12:00:00Z')

export const BTC: ProductSpec = {
  productId: 'BTC-USD',
  baseCurrency: 'BTC',
  quoteCurrency: 'USD',
  baseIncrement: '0.00000001',
  quoteIncrement: '0.01',
  priceIncrement: '0.01',
  baseMinSize: '0.00000001',
  quoteMinSize: '1',
  tradable: true,
}
export const ETH: ProductSpec = { ...BTC, productId: 'ETH-USD', baseCurrency: 'ETH' }

export const quote = (bid: number, ask: number, over: Partial<TopOfBook> = {}): TopOfBook => ({
  bid: dec(bid),
  ask: dec(ask),
  asOf: new Date(NOW.getTime() - 5_000),
  change24hPct: 1.2,
  ...over,
})

export const portfolio = (cash: number, positions: Record<string, { qty: number; cost: number }> = {}): AgentPortfolio => ({
  cashUsd: dec(cash),
  positions: Object.fromEntries(Object.entries(positions).map(([k, v]) => [k, { qty: dec(v.qty), costUsd: dec(v.cost) }])),
})

export function context(over: Partial<RiskContext> & { policyOver?: Partial<RiskPolicy> } = {}): RiskContext {
  const { policyOver, ...rest } = over
  const policy = { ...defaultPolicy('balanced', 10_000), ...policyOver }
  const pf = rest.portfolio ?? portfolio(10_000)
  const quotes = rest.quotes ?? { 'BTC-USD': quote(59_990, 60_010), 'ETH-USD': quote(1_699, 1_701) }
  const positionValues: Record<string, Big> = {}
  let equity = pf.cashUsd
  for (const [id, pos] of Object.entries(pf.positions)) {
    const q = quotes[id]
    const value = q ? pos.qty.times(q.bid.plus(q.ask).div(2)) : ZERO
    positionValues[id] = value
    equity = equity.plus(value)
  }
  return {
    now: NOW,
    mode: 'paper',
    status: 'active',
    ledger: 'paper',
    platformKillSwitch: false,
    live: { entitled: false, brokerConnected: false, brokerCanTrade: false, twoFactorEnabled: false, riskAcknowledged: false },
    policy,
    portfolio: pf,
    equityUsd: equity,
    positionValues,
    quotes,
    products: { 'BTC-USD': BTC, 'ETH-USD': ETH },
    today: { buyCount: 0, buyTurnoverUsd: ZERO },
    lastBuyAt: {},
    signalAsOf: new Date(NOW.getTime() - 30 * 60_000),
    feeRate: dec('0.012'),
    ...rest,
  }
}

export const buy = (usdAmount: number, productId = 'BTC-USD'): TradeIntent => ({
  productId,
  side: 'BUY',
  notionalUsd: dec(usdAmount),
  reason: 'test',
  targetWeight: 0.2,
  currentWeight: 0,
})

export const sell = (usdAmount: number, productId = 'BTC-USD', closePosition = false): TradeIntent => ({
  productId,
  side: 'SELL',
  notionalUsd: dec(usdAmount),
  closePosition,
  reason: 'test',
  targetWeight: 0,
  currentWeight: 0.2,
})

export const failedCodes = (checks: { code: string; outcome: string }[]) => checks.filter((c) => c.outcome === 'fail').map((c) => c.code)
export const adjustedCodes = (checks: { code: string; outcome: string }[]) => checks.filter((c) => c.outcome === 'adjusted').map((c) => c.code)
