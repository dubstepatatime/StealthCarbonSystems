import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/lib/db/client'
import { agents, auditEvents, ledgers, orders, positions, user } from '@/lib/db/schema'
import { defaultPolicy } from '@/lib/trading/limits'
import { freshDb, seedUser } from './helpers'

let db: Db
beforeAll(async () => {
  db = await freshDb()
})

describe('schema', () => {
  it('applies every migration to a clean database', async () => {
    const rows = await db.execute(sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)
    expect(((rows as { rows: { n: number }[] }).rows[0]!).n).toBeGreaterThanOrEqual(20)
  })

  it('stores money as exact decimal strings', async () => {
    const userId = await seedUser(db, 'u_money')
    const [agent] = await db.insert(agents).values({ userId, policy: defaultPolicy('balanced', 1000) }).returning()
    await db.insert(ledgers).values({ agentId: agent!.id, ledger: 'paper', cashUsd: '1000.123456789012345678', peakEquityUsd: '1000', dayStartEquityUsd: '1000', dayStartDate: '2026-11-26' })
    const [row] = await db.select().from(ledgers).where(eq(ledgers.agentId, agent!.id))
    expect(row!.cashUsd).toBe('1000.123456789012345678')
    expect(typeof row!.cashUsd).toBe('string')
  })

  it('keeps one agent per user and rejects invalid states', async () => {
    const userId = await seedUser(db, 'u_one')
    await db.insert(agents).values({ userId, policy: defaultPolicy('balanced', 1000) })
    await expect(db.insert(agents).values({ userId, policy: defaultPolicy('balanced', 1000) })).rejects.toThrow()
    const other = await seedUser(db, 'u_bad')
    await expect(db.insert(agents).values({ userId: other, policy: defaultPolicy('balanced', 1000), mode: 'yolo' as never })).rejects.toThrow()
    await expect(db.insert(agents).values({ userId: other, policy: defaultPolicy('balanced', 1000), cadenceMinutes: 1 })).rejects.toThrow()
  })

  it('never lets cash or a quantity go negative', async () => {
    const userId = await seedUser(db, 'u_neg')
    const [agent] = await db.insert(agents).values({ userId, policy: defaultPolicy('balanced', 1000) }).returning()
    await expect(db.insert(ledgers).values({ agentId: agent!.id, ledger: 'paper', cashUsd: '-1', peakEquityUsd: '0', dayStartEquityUsd: '0', dayStartDate: '2026-11-26' })).rejects.toThrow()
    await expect(db.insert(positions).values({ agentId: agent!.id, ledger: 'paper', productId: 'BTC-USD', qty: '-0.1', costUsd: '0' })).rejects.toThrow()
  })

  it('refuses a second order with the same client order id', async () => {
    const userId = await seedUser(db, 'u_idem')
    const [agent] = await db.insert(agents).values({ userId, policy: defaultPolicy('balanced', 1000) }).returning()
    const order = { agentId: agent!.id, userId, ledger: 'paper' as const, clientOrderId: 'same-key', productId: 'BTC-USD', side: 'BUY' as const, status: 'submitted' as const, notionalUsd: '100', reason: 'test', riskChecks: [] }
    await db.insert(orders).values(order)
    await expect(db.insert(orders).values(order)).rejects.toThrow()
  })

  it('makes the audit log append-only at the database', async () => {
    await db.insert(auditEvents).values({ actor: 'system', action: 'test.event', summary: 'Something happened.' })
    // Drizzle wraps the database error; the trigger's message is on `cause`.
    const blocked = (e: unknown) => /append-only/.test(String((e as { cause?: { message?: string } }).cause?.message ?? e))
    await expect(db.update(auditEvents).set({ summary: 'rewritten' })).rejects.toSatisfy(blocked)
    await expect(db.delete(auditEvents)).rejects.toSatisfy(blocked)
    await expect(db.execute(sql`truncate audit_events`)).rejects.toSatisfy(blocked)
    const rows = await db.select().from(auditEvents)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.summary).toBe('Something happened.')
  })

  it("removes a person's data when their account is deleted, and keeps the audit trail", async () => {
    const userId = await seedUser(db, 'u_del')
    const [agent] = await db.insert(agents).values({ userId, policy: defaultPolicy('balanced', 1000) }).returning()
    await db.insert(ledgers).values({ agentId: agent!.id, ledger: 'paper', cashUsd: '1000', peakEquityUsd: '1000', dayStartEquityUsd: '1000', dayStartDate: '2026-11-26' })
    await db.insert(auditEvents).values({ actor: 'user', userId, action: 'account.created', summary: 'Account created.' })
    await db.delete(user).where(eq(user.id, userId))
    expect(await db.select().from(agents).where(eq(agents.userId, userId))).toHaveLength(0)
    expect(await db.select().from(ledgers).where(eq(ledgers.agentId, agent!.id))).toHaveLength(0)
    expect(await db.select().from(auditEvents).where(eq(auditEvents.userId, userId))).toHaveLength(1)
  })
})
