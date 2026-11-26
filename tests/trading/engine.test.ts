import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/lib/db/client'
import { agents, auditEvents, ledgers, orders, positions } from '@/lib/db/schema'
import { simulateFill, type Broker } from '@/lib/trading/broker'
import type { DeskReport } from '@/lib/trading/desk'
import { dec } from '@/lib/trading/money'
import { freshDb, seedUser } from '../db/helpers'
import { BTC, ETH, quote } from './helpers'

const book = () => ({ 'BTC-USD': quote(59_990, 60_010, { asOf: new Date() }), 'ETH-USD': quote(1_699, 1_701, { asOf: new Date() }) })
const placed: string[] = []
const paper: Broker = {
  ledger: 'paper',
  getProducts: async () => ({ 'BTC-USD': BTC, 'ETH-USD': ETH }),
  getTopOfBook: async () => book(),
  getFeeRate: async () => dec('0.012'),
  placeOrder: async ({ clientOrderId, ticket }) => {
    placed.push(clientOrderId)
    const fill = simulateFill(ticket, book()[ticket.productId as 'BTC-USD'], dec('0.012'))
    return fill ? { status: 'filled', exchangeOrderId: `paper-${clientOrderId}`, fill } : { status: 'cancelled', exchangeOrderId: null, reason: 'no price' }
  },
}
vi.mock('@/lib/trading/paper-broker', () => ({ createPaperBroker: () => paper }))
vi.mock('@/lib/coinbase/api', () => ({ createCoinbaseBroker: async () => null }))

const { decideOrder, ensureAgent, runAgentTick } = await import('@/lib/trading/engine')

const desk = (conviction: number): { id: string; report: DeskReport } => ({
  id: 'desk-1',
  report: { asOf: new Date().toISOString(), source: 'quant', regime: 'risk_on', narrative: '', segments: [], signals: [{ productId: 'BTC-USD', quantScore: conviction, aiView: null, conviction, word: 'BULLISH', rationale: '' }] },
})

let db: Db
beforeAll(async () => {
  db = await freshDb()
})

describe('agent engine', () => {
  it('starts every agent paused, in paper mode, and does nothing until resumed', async () => {
    const agent = await ensureAgent(db, await seedUser(db, 'u_paused'))
    expect(agent).toMatchObject({ mode: 'paper', status: 'paused' })
    expect((await runAgentTick(db, agent.id, desk(1))).outcome).toBe('skipped')
    expect(placed).toHaveLength(0)
  })

  it('buys inside its limits on a strong signal, keeps the books, and exits when the signal turns', async () => {
    const userId = await seedUser(db, 'u_run')
    const agent = await ensureAgent(db, userId)
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agent.id))

    const first = await runAgentTick(db, agent.id, desk(1))
    expect(first).toMatchObject({ outcome: 'ok', summary: { filled: 1 } })
    const [pos] = await db.select().from(positions).where(eq(positions.agentId, agent.id))
    const [cash] = await db.select().from(ledgers).where(eq(ledgers.agentId, agent.id))
    // conservative: 15% position cap and $100 largest order on $1,000
    const spent = dec(1000).minus(cash!.cashUsd)
    expect(spent.gt(90) && spent.lte(dec(100).times('1.012'))).toBe(true)
    expect(dec(pos!.qty).gt(0)).toBe(true)
    expect(dec(pos!.costUsd).eq(spent)).toBe(true)

    // cooldown: an immediate second run adds nothing
    const second = await runAgentTick(db, agent.id, desk(1))
    expect(second.summary.filled).toBe(0)

    const exit = await runAgentTick(db, agent.id, desk(-1))
    expect(exit.summary.filled).toBe(1)
    expect(await db.select().from(positions).where(eq(positions.agentId, agent.id))).toHaveLength(0)
    const [after] = await db.select().from(ledgers).where(eq(ledgers.agentId, agent.id))
    expect(dec(after!.cashUsd).lt(1000)).toBe(true) // paid the spread and two fees
    expect(dec(after!.realizedPnlUsd).lt(0)).toBe(true)

    const ids = (await db.select().from(orders).where(eq(orders.agentId, agent.id))).map((o) => o.clientOrderId)
    expect(new Set(ids).size).toBe(ids.length)
    const trail = await db.select().from(auditEvents).where(eq(auditEvents.userId, userId))
    expect(trail.filter((e) => e.action === 'agent.order.filled')).toHaveLength(2)
  })

  it('halts on the daily loss limit and stays halted', async () => {
    const agent = await ensureAgent(db, await seedUser(db, 'u_halt'))
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agent.id))
    await db.update(ledgers).set({ cashUsd: '900', dayStartEquityUsd: '1000', dayStartDate: new Date().toISOString().slice(0, 10) }).where(eq(ledgers.agentId, agent.id))
    const before = placed.length
    expect((await runAgentTick(db, agent.id, desk(1))).outcome).toBe('halted')
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]).toMatchObject({ status: 'halted', haltReason: 'DAILY_LOSS_LIMIT' })
    expect((await runAgentTick(db, agent.id, desk(1))).outcome).toBe('skipped')
    expect(placed.length).toBe(before)
  })

  it('refuses to trade live without a broker, and never lets one user decide another user\'s order', async () => {
    const owner = await seedUser(db, 'u_owner')
    const agent = await ensureAgent(db, owner)
    await db.update(agents).set({ status: 'active', mode: 'auto' }).where(eq(agents.id, agent.id))
    const before = placed.length
    expect((await runAgentTick(db, agent.id, desk(1))).outcome).toBe('skipped')
    expect(placed.length).toBe(before)

    const [order] = await db.insert(orders).values({ agentId: agent.id, userId: owner, ledger: 'paper', clientOrderId: 'await-1', productId: 'BTC-USD', side: 'BUY', status: 'awaiting_approval', notionalUsd: '50', reason: 'test', riskChecks: [] }).returning()
    const intruder = await seedUser(db, 'u_intruder')
    expect(await decideOrder(db, intruder, order!.id, true)).toBe('That order is no longer waiting.')
    expect((await db.select().from(orders).where(eq(orders.id, order!.id)))[0]!.status).toBe('awaiting_approval')
    expect(placed.length).toBe(before)
  })
})
