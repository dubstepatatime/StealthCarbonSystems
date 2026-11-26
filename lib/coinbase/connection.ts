/**
 * The stored Coinbase link: tokens sealed at rest, refreshed one at a time.
 *
 * Coinbase refresh tokens are single use, and replaying an old one ends the
 * link. So a refresh happens inside a transaction that holds a row lock, and
 * the new tokens are saved before anyone uses them.
 */
import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { agents, coinbaseConnections, ledgers, positions } from '@/lib/db/schema'
import { open, seal } from '@/lib/security/crypto'
import { audit } from '@/lib/security/audit'
import { canTrade, OAuthError, refreshTokens, revoke, type TokenSet } from './oauth'

const aad = (userId: string, kind: 'access' | 'refresh') => `coinbase:${kind}:${userId}`

export interface ConnectionView {
  linked: boolean
  canTrade: boolean
  needsReauth: boolean
  scopes: string[]
}

export async function getConnectionView(db: Db, userId: string): Promise<ConnectionView> {
  const [row] = await db.select().from(coinbaseConnections).where(eq(coinbaseConnections.userId, userId))
  if (!row) return { linked: false, canTrade: false, needsReauth: false, scopes: [] }
  const scopes = row.scopes.split(' ').filter(Boolean)
  return { linked: true, canTrade: row.status === 'active' && canTrade(scopes), needsReauth: row.status !== 'active', scopes }
}

/**
 * Forget the live book and return the agent to paper mode. The live book
 * records what the agent bought in one specific Coinbase account; it means
 * nothing for a different account, or once the link is gone.
 */
export async function resetLiveBook(db: Db, userId: string): Promise<void> {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId))
  if (!agent) return
  await db.transaction(async (tx) => {
    await tx.delete(positions).where(and(eq(positions.agentId, agent.id), eq(positions.ledger, 'live')))
    await tx.delete(ledgers).where(and(eq(ledgers.agentId, agent.id), eq(ledgers.ledger, 'live')))
    await tx.update(agents).set({ mode: 'paper' }).where(eq(agents.id, agent.id))
  })
}

export async function saveConnection(db: Db, userId: string, tokens: TokenSet, coinbaseUserId: string): Promise<void> {
  if (!tokens.refreshToken) throw new OAuthError('no_refresh_token')
  const [previous] = await db.select({ coinbaseUserId: coinbaseConnections.coinbaseUserId }).from(coinbaseConnections).where(eq(coinbaseConnections.userId, userId))
  if (previous && previous.coinbaseUserId !== coinbaseUserId) await resetLiveBook(db, userId)
  const values = {
    userId,
    coinbaseUserId,
    scopes: tokens.scopes.join(' '),
    accessTokenEnc: seal(tokens.accessToken, aad(userId, 'access')),
    refreshTokenEnc: seal(tokens.refreshToken, aad(userId, 'refresh')),
    accessExpiresAt: tokens.expiresAt,
    status: 'active' as const,
    lastError: null,
  }
  await db.insert(coinbaseConnections).values(values).onConflictDoUpdate({ target: coinbaseConnections.userId, set: values })
}

/** A valid access token for this user, refreshing if it is about to expire. Null when there is no usable link. */
export async function getAccessToken(db: Db, userId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${coinbaseConnections} where ${coinbaseConnections.userId} = ${userId} for update`)
    const [row] = await tx.select().from(coinbaseConnections).where(eq(coinbaseConnections.userId, userId))
    if (!row || row.status !== 'active') return null
    if (row.accessExpiresAt.getTime() - Date.now() > 90_000) return open(row.accessTokenEnc, aad(userId, 'access'))
    if (!row.refreshTokenEnc) return null
    try {
      const next = await refreshTokens(open(row.refreshTokenEnc, aad(userId, 'refresh')))
      await tx
        .update(coinbaseConnections)
        .set({
          accessTokenEnc: seal(next.accessToken, aad(userId, 'access')),
          refreshTokenEnc: next.refreshToken ? seal(next.refreshToken, aad(userId, 'refresh')) : row.refreshTokenEnc,
          accessExpiresAt: next.expiresAt,
          lastRefreshedAt: new Date(),
          lastError: null,
        })
        .where(eq(coinbaseConnections.userId, userId))
      return next.accessToken
    } catch (err) {
      const code = err instanceof OAuthError ? err.code : 'refresh_failed'
      // invalid_grant means the link is over; anything else may be transient.
      if (code === 'invalid_grant') await tx.update(coinbaseConnections).set({ status: 'needs_reauth', lastError: code }).where(eq(coinbaseConnections.userId, userId))
      return null
    }
  })
}

export async function markNeedsReauth(db: Db, userId: string, reason: string): Promise<void> {
  await db.update(coinbaseConnections).set({ status: 'needs_reauth', lastError: reason.slice(0, 200) }).where(eq(coinbaseConnections.userId, userId))
}

export async function disconnect(db: Db, userId: string): Promise<void> {
  const [row] = await db.select().from(coinbaseConnections).where(eq(coinbaseConnections.userId, userId))
  if (!row) return
  try {
    await revoke(open(row.accessTokenEnc, aad(userId, 'access')))
  } catch {
    /* delete locally regardless */
  }
  await db.delete(coinbaseConnections).where(eq(coinbaseConnections.userId, userId))
  await resetLiveBook(db, userId)
  await audit(db, { userId, actor: 'user', action: 'coinbase.unlinked', summary: 'Coinbase account unlinked and tokens deleted.' })
}
