/**
 * The agent engine: one "tick" for one agent.
 *
 *   load state -> mark the book -> circuit breakers -> targets -> intents
 *   -> risk engine -> (approval queue | broker) -> book-keeping -> audit
 *
 * Every order is written to the database before it is sent, under a client
 * order id that is unique for that run, product and side. A crashed or retried
 * tick therefore cannot place the same order twice.
 */
import 'server-only'
import { and, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { effectivePlan } from '@/lib/billing/plans'
import { createCoinbaseBroker } from '@/lib/coinbase/api'
import { getConnectionView } from '@/lib/coinbase/connection'
import type { Db } from '@/lib/db/client'
import { agentRuns, agents, equitySnapshots, ledgers, orders, positions, platformFlags, subscriptions, user, type AgentRunSummary } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { audit } from '@/lib/security/audit'
import { planRebalance, targetWeights, valuePortfolio } from './allocator'
import type { Broker, PlaceOrderResult } from './broker'
import type { DeskReport } from './desk'
import { defaultPolicy, PLATFORM_LIMITS } from './limits'
import { dec, maxBig, toDecimalString, usd, ZERO, type Big } from './money'
import { createPaperBroker } from './paper-broker'
import { applyFill } from './portfolio'
import { checkHalts, evaluateIntent, HALT_MESSAGES, type RiskContext } from './risk'
import type { AgentPortfolio, Ledger, OrderStatus, RiskDecision, TradeIntent } from './types'

type Agent = typeof agents.$inferSelect
const utcDay = (d: Date) => d.toISOString().slice(0, 10)

export async function platformHalted(db: Db): Promise<boolean> {
  if (env.tradingHalted()) return true
  const [flag] = await db.select().from(platformFlags).where(eq(platformFlags.key, 'trading_halted'))
  return flag?.value === true
}

/**
 * The per-agent execution lock. Scheduled runs, manual runs, approvals and
 * capital changes all take it, so only one of them touches an agent's book at a time.
 */
export async function acquireLease(db: Db, agentId: string, now = new Date()): Promise<boolean> {
  const [row] = await db.update(agents).set({ leaseUntil: new Date(now.getTime() + 5 * 60_000) }).where(and(eq(agents.id, agentId), or(isNull(agents.leaseUntil), lt(agents.leaseUntil, now)))).returning({ id: agents.id })
  return Boolean(row)
}
export async function releaseLease(db: Db, agentId: string): Promise<void> {
  await db.update(agents).set({ leaseUntil: null }).where(eq(agents.id, agentId))
}

/** The user's agent, created on first use: paused, paper mode, conservative limits. */
export async function ensureAgent(db: Db, userId: string): Promise<Agent> {
  const [existing] = await db.select().from(agents).where(eq(agents.userId, userId))
  if (existing) return existing
  const policy = defaultPolicy('conservative', 1_000)
  const [created] = await db.insert(agents).values({ userId, policy }).onConflictDoNothing().returning()
  const agent = created ?? (await db.select().from(agents).where(eq(agents.userId, userId)))[0]!
  await ensureLedger(db, agent, 'paper')
  return agent
}

async function ensureLedger(db: Db, agent: Agent, ledger: Ledger) {
  const capital = agent.policy.capitalUsd
  await db.insert(ledgers).values({ agentId: agent.id, ledger, cashUsd: capital, peakEquityUsd: capital, dayStartEquityUsd: capital, dayStartDate: utcDay(new Date()) }).onConflictDoNothing()
  const [row] = await db.select().from(ledgers).where(and(eq(ledgers.agentId, agent.id), eq(ledgers.ledger, ledger)))
  return row!
}

export async function loadPortfolio(db: Db, agentId: string, ledger: Ledger): Promise<AgentPortfolio> {
  const [book] = await db.select().from(ledgers).where(and(eq(ledgers.agentId, agentId), eq(ledgers.ledger, ledger)))
  const rows = await db.select().from(positions).where(and(eq(positions.agentId, agentId), eq(positions.ledger, ledger)))
  return { cashUsd: dec(book?.cashUsd ?? '0'), positions: Object.fromEntries(rows.filter((r) => dec(r.qty).gt(0)).map((r) => [r.productId, { qty: dec(r.qty), costUsd: dec(r.costUsd) }])) }
}

async function savePortfolio(db: Db, agentId: string, ledger: Ledger, before: AgentPortfolio, after: AgentPortfolio, realized: Big) {
  await db.transaction(async (tx) => {
    await tx.update(ledgers).set({ cashUsd: toDecimalString(after.cashUsd), realizedPnlUsd: sql`${ledgers.realizedPnlUsd} + ${toDecimalString(realized)}` }).where(and(eq(ledgers.agentId, agentId), eq(ledgers.ledger, ledger)))
    for (const id of new Set([...Object.keys(before.positions), ...Object.keys(after.positions)])) {
      const p = after.positions[id]
      if (!p) await tx.delete(positions).where(and(eq(positions.agentId, agentId), eq(positions.ledger, ledger), eq(positions.productId, id)))
      else {
        const values = { agentId, ledger, productId: id, qty: toDecimalString(p.qty), costUsd: toDecimalString(p.costUsd) }
        await tx.insert(positions).values(values).onConflictDoUpdate({ target: [positions.agentId, positions.ledger, positions.productId], set: { qty: values.qty, costUsd: values.costUsd } })
      }
    }
  })
}

interface Prepared {
  ctx: RiskContext
  broker: Broker
  portfolio: AgentPortfolio
  mids: Record<string, Big | undefined>
}

/** Everything the risk engine needs, gathered fresh. */
async function prepare(db: Db, agent: Agent, ledger: Ledger, signalAsOf: Date, now: Date): Promise<Prepared | { error: string }> {
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, agent.userId))
  const [owner] = await db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, agent.userId))
  const link = await getConnectionView(db, agent.userId)
  const broker = ledger === 'paper' ? createPaperBroker() : await createCoinbaseBroker(db, agent.userId)
  if (!broker) return { error: 'Coinbase is not linked, or the link needs to be renewed.' }

  if (ledger === 'live') {
    // An order the exchange accepted but has not reported on could still fill. Until it is settled the book is incomplete, so nothing new is sent.
    const [open] = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.agentId, agent.id), eq(orders.ledger, 'live'), eq(orders.status, 'submitted'))).limit(1)
    if (open) return { error: 'An earlier order is still unsettled. No new orders until it is resolved.' }
  }
  const portfolio = await loadPortfolio(db, agent.id, ledger)
  const ids = [...new Set([...agent.policy.universe, ...Object.keys(portfolio.positions)])]
  const [products, quotes, feeRate, exchangeAvailable] = await Promise.all([broker.getProducts(ids), broker.getTopOfBook(ids), broker.getFeeRate(), broker.getAvailable?.(ids)])
  const mids: Record<string, Big | undefined> = Object.fromEntries(Object.entries(quotes).map(([id, q]) => [id, q.bid.plus(q.ask).div(2)]))
  const valuation = valuePortfolio(portfolio, mids)

  const dayStart = new Date(`${utcDay(now)}T00:00:00Z`)
  const todays = await db
    .select({ productId: orders.productId, notionalUsd: orders.notionalUsd, createdAt: orders.createdAt })
    .from(orders)
    .where(and(eq(orders.agentId, agent.id), eq(orders.ledger, ledger), eq(orders.side, 'BUY'), inArray(orders.status, ['submitted', 'filled', 'partially_filled']), gte(orders.createdAt, new Date(now.getTime() - 24 * 3_600_000))))
  const lastBuyAt: Record<string, Date | undefined> = {}
  let buyCount = 0
  let turnover = ZERO
  for (const o of todays) {
    if (!lastBuyAt[o.productId] || lastBuyAt[o.productId]! < o.createdAt) lastBuyAt[o.productId] = o.createdAt
    if (o.createdAt >= dayStart) {
      buyCount++
      turnover = turnover.plus(o.notionalUsd)
    }
  }
  const ctx: RiskContext = {
    now,
    mode: agent.mode,
    status: agent.status,
    ledger,
    platformKillSwitch: await platformHalted(db),
    // A downgrade shrinks what the plan allows; the agent's stored capital must still fit it.
    live: { entitled: effectivePlan(sub).liveTrading && dec(agent.policy.capitalUsd).lte(effectivePlan(sub).maxCapitalUsd), brokerConnected: link.linked && !link.needsReauth, brokerCanTrade: link.canTrade, twoFactorEnabled: Boolean(owner?.twoFactorEnabled), riskAcknowledged: Boolean(agent.riskAcknowledgedAt) },
    policy: agent.policy,
    portfolio,
    equityUsd: valuation.equityUsd,
    positionValues: valuation.values,
    quotes,
    products,
    today: { buyCount, buyTurnoverUsd: turnover },
    lastBuyAt,
    signalAsOf,
    feeRate,
    exchangeAvailable,
  }
  return { ctx, broker, portfolio, mids }
}

const STATUS_OF: Record<PlaceOrderResult['status'], OrderStatus> = { filled: 'filled', partially_filled: 'partially_filled', submitted: 'submitted', cancelled: 'cancelled', failed: 'failed' }

/** Send an approved ticket and record the outcome. Returns the portfolio afterwards. */
async function execute(db: Db, agent: Agent, ledger: Ledger, orderId: string, clientOrderId: string, decision: RiskDecision, broker: Broker, portfolio: AgentPortfolio): Promise<{ portfolio: AgentPortfolio; status: OrderStatus }> {
  const ticket = decision.ticket!
  await db.update(orders).set({ status: 'submitted', submittedAt: new Date(), baseSize: ticket.baseSize, limitPrice: ticket.limitPrice, notionalUsd: ticket.notionalUsd, riskChecks: decision.checks }).where(eq(orders.id, orderId))
  let result: PlaceOrderResult
  try {
    result = await broker.placeOrder({ clientOrderId, ticket })
  } catch (err) {
    // Unknown outcome: leave it as submitted so reconciliation settles it; never resend under a new id.
    await db.update(orders).set({ error: err instanceof Error ? err.message.slice(0, 300) : 'Broker error' }).where(eq(orders.id, orderId))
    return { portfolio, status: 'submitted' }
  }
  let next = portfolio
  const patch: Partial<typeof orders.$inferInsert> = { status: STATUS_OF[result.status], exchangeOrderId: 'exchangeOrderId' in result ? result.exchangeOrderId : null }
  if (result.status === 'filled' || result.status === 'partially_filled') {
    const applied = applyFill(portfolio, ticket.productId, ticket.side, result.fill)
    next = applied.portfolio
    await savePortfolio(db, agent.id, ledger, portfolio, next, applied.realizedPnlUsd)
    Object.assign(patch, { filledBaseSize: toDecimalString(result.fill.baseSize), filledQuoteUsd: toDecimalString(result.fill.quoteUsd), feeUsd: toDecimalString(result.fill.feeUsd), avgPrice: toDecimalString(result.fill.price), realizedPnlUsd: toDecimalString(applied.realizedPnlUsd), completedAt: new Date() })
    await audit(db, { userId: agent.userId, actor: 'agent', action: 'agent.order.filled', targetType: 'order', targetId: orderId, summary: `${ledger === 'paper' ? 'Paper ' : ''}${ticket.side === 'BUY' ? 'bought' : 'sold'} ${result.fill.baseSize.toFixed()} ${ticket.productId.split('-')[0]} for $${usd(result.fill.quoteUsd)}.` })
  } else if (result.status !== 'submitted') {
    Object.assign(patch, { error: result.reason.slice(0, 300), completedAt: new Date() })
  }
  await db.update(orders).set(patch).where(eq(orders.id, orderId))
  return { portfolio: next, status: STATUS_OF[result.status] }
}

export interface TickResult {
  outcome: 'ok' | 'no_trades' | 'skipped' | 'halted' | 'error'
  summary: AgentRunSummary
  error?: string
}

export async function runAgentTick(db: Db, agentId: string, desk: { id: string; report: DeskReport }, now = new Date()): Promise<TickResult> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId))
  if (!agent) return { outcome: 'error', summary: {}, error: 'Agent not found' }
  const ledger: Ledger = agent.mode === 'paper' ? 'paper' : 'live'
  const started = new Date()
  const finish = async (result: TickResult): Promise<TickResult> => {
    await db.insert(agentRuns).values({ agentId, ledger, deskRunId: desk.id, outcome: result.outcome, summary: result.summary, error: result.error, startedAt: started, finishedAt: new Date() })
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, agent.userId))
    const cadence = Math.max(agent.cadenceMinutes, effectivePlan(sub).minCadenceMinutes)
    await db.update(agents).set({ lastRunAt: now, nextRunAt: new Date(now.getTime() + cadence * 60_000), leaseUntil: null }).where(eq(agents.id, agentId))
    return result
  }
  if (agent.status !== 'active') return finish({ outcome: 'skipped', summary: { note: `Agent is ${agent.status}.` } })

  try {
    const book = await ensureLedger(db, agent, ledger)
    const prepared = await prepare(db, agent, ledger, new Date(desk.report.asOf), now)
    if ('error' in prepared) return finish({ outcome: 'skipped', summary: { note: prepared.error } })
    const { ctx, broker, mids } = prepared
    let portfolio = prepared.portfolio
    const equity = ctx.equityUsd

    // Roll the day, track the peak, then test the circuit breakers.
    const today = utcDay(now)
    const dayStartEquity = book.dayStartDate === today ? dec(book.dayStartEquityUsd) : equity
    const peak = maxBig(dec(book.peakEquityUsd), equity)
    await db.update(ledgers).set({ dayStartDate: today, dayStartEquityUsd: toDecimalString(dayStartEquity), peakEquityUsd: toDecimalString(peak) }).where(and(eq(ledgers.agentId, agentId), eq(ledgers.ledger, ledger)))
    await db.insert(equitySnapshots).values({ agentId, ledger, at: now, equityUsd: toDecimalString(equity), cashUsd: toDecimalString(portfolio.cashUsd) })

    const halt = checkHalts({ equityUsd: equity, dayStartEquityUsd: dayStartEquity, peakEquityUsd: peak, policy: agent.policy })
    if (halt) {
      await db.update(agents).set({ status: 'halted', haltReason: halt }).where(eq(agents.id, agentId))
      await audit(db, { userId: agent.userId, actor: 'agent', action: 'agent.halted', targetType: 'agent', targetId: agentId, summary: HALT_MESSAGES[halt], metadata: { equityUsd: usd(equity) } })
      return finish({ outcome: 'halted', summary: { equityUsd: usd(equity), note: HALT_MESSAGES[halt] } })
    }

    const convictions = Object.fromEntries(desk.report.signals.map((s) => [s.productId, s.conviction]))
    const targets = targetWeights({ convictions, regime: desk.report.regime, policy: agent.policy, currentWeights: valuePortfolio(portfolio, mids).weights })
    const intents = planRebalance({ targets, portfolio, mids, policy: agent.policy })
    const runId = crypto.randomUUID()
    let approved = 0
    let rejected = 0
    let filled = 0

    for (const intent of intents) {
      // Re-mark after each fill so later checks see the cash and positions as they now are.
      const valuation = valuePortfolio(portfolio, mids)
      const decision = evaluateIntent(intent, { ...ctx, portfolio, equityUsd: valuation.equityUsd, positionValues: valuation.values })
      const clientOrderId = `sc-${runId}-${intent.productId}-${intent.side}`.slice(0, 120)
      const awaiting = decision.approved && agent.mode === 'approval'
      const [row] = await db
        .insert(orders)
        .values({
          agentId,
          userId: agent.userId,
          ledger,
          runId,
          clientOrderId,
          productId: intent.productId,
          side: intent.side,
          status: !decision.approved ? 'rejected' : 'awaiting_approval',
          baseSize: decision.ticket?.baseSize,
          limitPrice: decision.ticket?.limitPrice,
          notionalUsd: decision.ticket?.notionalUsd ?? toDecimalString(intent.notionalUsd.round(2)),
          reason: intent.reason,
          riskChecks: decision.checks,
          expiresAt: awaiting ? new Date(now.getTime() + PLATFORM_LIMITS.approvalTtlMinutes * 60_000) : null,
          completedAt: decision.approved ? null : now,
        })
        .returning({ id: orders.id })
      if (!decision.approved) {
        rejected++
        continue
      }
      approved++
      if (awaiting) {
        await audit(db, { userId: agent.userId, actor: 'agent', action: 'agent.order.proposed', targetType: 'order', targetId: row!.id, summary: `Proposed: ${intent.side} $${usd(dec(decision.ticket!.notionalUsd))} of ${intent.productId}. Waiting for your approval.` })
        continue
      }
      // The user may have paused, or a breaker tripped, since this run loaded the agent.
      const [live] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId))
      if (live?.status !== 'active') {
        await db.update(orders).set({ status: 'rejected', error: 'Agent was paused during the run.', completedAt: new Date() }).where(eq(orders.id, row!.id))
        break
      }
      const done = await execute(db, agent, ledger, row!.id, clientOrderId, decision, broker, portfolio)
      portfolio = done.portfolio
      if (done.status === 'filled' || done.status === 'partially_filled') {
        filled++
        if (intent.side === 'BUY') {
          ctx.today.buyCount++
          ctx.today.buyTurnoverUsd = ctx.today.buyTurnoverUsd.plus(decision.ticket!.notionalUsd)
          ctx.lastBuyAt[intent.productId] = now
        }
      }
    }
    return finish({ outcome: intents.length ? 'ok' : 'no_trades', summary: { regime: desk.report.regime, equityUsd: usd(equity), targets, intents: intents.length, approved, rejected, filled } })
  } catch (err) {
    return finish({ outcome: 'error', summary: {}, error: err instanceof Error ? err.message.slice(0, 300) : 'Unknown error' })
  }
}

/** Approve or decline an order that is waiting. Approval re-runs every risk check against current prices first. */
export async function decideOrder(db: Db, userId: string, orderId: string, approve: boolean, now = new Date()): Promise<string> {
  // Claim it atomically so a double click cannot send it twice.
  const [order] = await db
    .update(orders)
    .set({ status: approve ? 'submitted' : 'rejected', completedAt: approve ? null : now })
    .where(and(eq(orders.id, orderId), eq(orders.userId, userId), eq(orders.status, 'awaiting_approval')))
    .returning()
  if (!order) return 'That order is no longer waiting.'
  if (!approve) {
    await audit(db, { userId, actor: 'user', action: 'agent.order.declined', targetType: 'order', targetId: orderId, summary: `Declined ${order.side} ${order.productId}.` })
    return 'Order declined.'
  }
  const fail = async (status: OrderStatus, message: string) => {
    await db.update(orders).set({ status, error: message, completedAt: now }).where(eq(orders.id, orderId))
    return message
  }
  if (order.expiresAt && order.expiresAt < now) return fail('expired', 'That proposal expired. The agent will look again on its next run.')
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, order.agentId), eq(agents.userId, userId)))
  if (!agent) return fail('failed', 'Agent not found.')
  const prepared = await prepare(db, agent, order.ledger, order.createdAt, now)
  if ('error' in prepared) return fail('failed', prepared.error)
  // Circuit breakers apply to approvals too: losses since the proposal may have crossed a limit.
  const [book] = await db.select().from(ledgers).where(and(eq(ledgers.agentId, agent.id), eq(ledgers.ledger, order.ledger)))
  const halt = book ? checkHalts({ equityUsd: prepared.ctx.equityUsd, dayStartEquityUsd: dec(book.dayStartEquityUsd), peakEquityUsd: maxBig(dec(book.peakEquityUsd), prepared.ctx.equityUsd), policy: agent.policy }) : null
  if (halt && order.side === 'BUY') {
    await db.update(agents).set({ status: 'halted', haltReason: halt }).where(eq(agents.id, agent.id))
    await audit(db, { userId, actor: 'agent', action: 'agent.halted', targetType: 'agent', targetId: agent.id, summary: HALT_MESSAGES[halt] })
    return fail('rejected', HALT_MESSAGES[halt])
  }
  const intent: TradeIntent = { productId: order.productId, side: order.side, notionalUsd: dec(order.notionalUsd), reason: order.reason, targetWeight: 0, currentWeight: 0 }
  const decision = evaluateIntent(intent, prepared.ctx)
  if (!decision.approved) {
    await db.update(orders).set({ riskChecks: decision.checks }).where(eq(orders.id, orderId))
    return fail('rejected', decision.checks.find((c) => c.outcome === 'fail')?.message ?? 'The order no longer passes the risk checks.')
  }
  await audit(db, { userId, actor: 'user', action: 'agent.order.approved', targetType: 'order', targetId: orderId, summary: `Approved ${order.side} ${order.productId}.` })
  const done = await execute(db, agent, order.ledger, orderId, order.clientOrderId, decision, prepared.broker, prepared.portfolio)
  return done.status === 'filled' || done.status === 'partially_filled' ? 'Order filled.' : done.status === 'submitted' ? 'Order sent.' : 'The order did not trade inside its price limit.'
}

/** Claim agents that are due, one lease each, so two workers never run the same agent. */
export async function claimDueAgents(db: Db, limit: number, now = new Date()): Promise<string[]> {
  const lease = new Date(now.getTime() + 5 * 60_000)
  const due = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.status, 'active'), or(isNull(agents.nextRunAt), lte(agents.nextRunAt, now)), or(isNull(agents.leaseUntil), lt(agents.leaseUntil, now))))
    .limit(limit)
  const claimed: string[] = []
  for (const { id } of due) {
    const [row] = await db.update(agents).set({ leaseUntil: lease }).where(and(eq(agents.id, id), or(isNull(agents.leaseUntil), lt(agents.leaseUntil, now)))).returning({ id: agents.id })
    if (row) claimed.push(row.id)
  }
  return claimed
}

/** Expire stale proposals. */
export async function expireProposals(db: Db, now = new Date()): Promise<void> {
  await db.update(orders).set({ status: 'expired', completedAt: now }).where(and(eq(orders.status, 'awaiting_approval'), lt(orders.expiresAt, now)))
}
