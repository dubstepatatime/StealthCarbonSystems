import { and, eq, ne } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/session'
import { fetchCoinbaseUserId } from '@/lib/coinbase/api'
import { saveConnection } from '@/lib/coinbase/connection'
import { exchangeCode, revoke, unexpectedScopes } from '@/lib/coinbase/oauth'
import { getDb } from '@/lib/db/client'
import { coinbaseConnections, oauthStates } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { audit } from '@/lib/security/audit'
import { open, sha256 } from '@/lib/security/crypto'

export const dynamic = 'force-dynamic'

/** Where Coinbase sends the user back. Every failure lands on the desk with a fixed code; nothing from the query is echoed. */
export async function GET(request: Request) {
  const back = (code: string) => NextResponse.redirect(`${env.appUrl()}/desk?msg=${code}`)
  const user = await currentUser()
  if (!user) return NextResponse.redirect(`${env.appUrl()}/sign-in`)
  const params = new URL(request.url).searchParams
  const state = params.get('state') ?? ''
  const code = params.get('code') ?? ''
  if (state.length < 20 || state.length > 200 || code.length < 1 || code.length > 2000) return back('link-failed')

  const db = await getDb()
  // Single use: the row is deleted as it is read, and it must belong to the signed-in user.
  const [pending] = await db.delete(oauthStates).where(and(eq(oauthStates.stateHash, sha256(state)), eq(oauthStates.userId, user.id))).returning()
  if (!pending || pending.expiresAt < new Date()) return back('link-failed')

  try {
    const tokens = await exchangeCode(code, open(pending.codeVerifierEnc, `oauth:${user.id}`))
    const extra = unexpectedScopes(tokens.scopes)
    if (extra.length || !tokens.refreshToken) {
      // More permission than we asked for (or no way to refresh): refuse the link.
      await revoke(tokens.accessToken)
      await audit(db, { userId: user.id, actor: 'system', action: 'coinbase.link.refused', summary: 'Coinbase link refused: unexpected permissions.', metadata: { extra } })
      return back('link-refused')
    }
    const coinbaseUserId = await fetchCoinbaseUserId(tokens.accessToken)
    const [taken] = await db.select({ id: coinbaseConnections.id }).from(coinbaseConnections).where(and(eq(coinbaseConnections.coinbaseUserId, coinbaseUserId), ne(coinbaseConnections.userId, user.id)))
    if (taken) {
      await revoke(tokens.accessToken)
      return back('link-taken')
    }
    await saveConnection(db, user.id, tokens, coinbaseUserId)
    await audit(db, { userId: user.id, actor: 'user', action: 'coinbase.linked', summary: 'Coinbase account linked with trade and read permissions. No withdrawal permission.', metadata: { scopes: tokens.scopes } })
    return back('linked')
  } catch {
    return back('link-failed')
  }
}
