/**
 * Coinbase OAuth 2.0 (authorization code + PKCE).
 *
 * The scope list is a compile-time constant and contains no scope that can
 * send, withdraw, transfer or touch payment methods. After the code exchange
 * the granted scopes are checked against the same list; anything else and the
 * link is refused.
 */
import 'server-only'
import { z } from 'zod'
import { env } from '@/lib/env'
import { randomToken, sha256Base64Url } from '@/lib/security/crypto'

const AUTH_URL = 'https://login.coinbase.com/oauth2/auth'
const TOKEN_URL = 'https://login.coinbase.com/oauth2/token'
const REVOKE_URL = 'https://login.coinbase.com/oauth2/revoke'

export const READ_SCOPES = ['wallet:user:read', 'wallet:accounts:read', 'wallet:transactions:read'] as const
export const TRADE_SCOPES = ['wallet:buys:create', 'wallet:sells:create'] as const
/** Everything this app ever asks for. `offline_access` yields the refresh token. */
export const REQUESTED_SCOPES = [...READ_SCOPES, ...TRADE_SCOPES, 'offline_access'] as const
const ALLOWED: ReadonlySet<string> = new Set(REQUESTED_SCOPES)

export const redirectUri = () => `${env.appUrl()}/api/coinbase/callback`

export function startAuthorization(): { url: string; state: string; codeVerifier: string } {
  const cfg = env.coinbase()
  if (!cfg) throw new Error('Coinbase is not configured')
  const state = randomToken(32)
  const codeVerifier = randomToken(48)
  const url = new URL(AUTH_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('state', state)
  url.searchParams.set('scope', REQUESTED_SCOPES.join(' '))
  url.searchParams.set('code_challenge', sha256Base64Url(codeVerifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return { url: url.toString(), state, codeVerifier }
}

const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(), scope: z.string().optional() })
export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  scopes: string[]
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

async function tokenRequest(fields: Record<string, string>): Promise<TokenSet> {
  const cfg = env.coinbase()
  if (!cfg) throw new OAuthError('not_configured')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...fields, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* error bodies are not always JSON */
  }
  if (!res.ok) throw new OAuthError(typeof (json as { error?: unknown })?.error === 'string' ? (json as { error: string }).error : `http_${res.status}`)
  const parsed = tokenSchema.safeParse(json)
  if (!parsed.success) throw new OAuthError('bad_token_response')
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: new Date(Date.now() + parsed.data.expires_in * 1000),
    scopes: (parsed.data.scope ?? '').split(/[\s,]+/).filter(Boolean),
  }
}

export const exchangeCode = (code: string, codeVerifier: string) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: codeVerifier })
export const refreshTokens = (refreshToken: string) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })

/** Scopes outside our list, if Coinbase granted any. A non-empty result means: refuse the link. */
export const unexpectedScopes = (granted: string[]) => granted.filter((s) => !ALLOWED.has(s))
export const canTrade = (granted: string[]) => TRADE_SCOPES.every((s) => granted.includes(s))

/** Best effort: Coinbase answers 200 whether or not the token was live. Always delete local tokens afterwards. */
export async function revoke(accessToken: string): Promise<void> {
  const cfg = env.coinbase()
  if (!cfg) return
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${accessToken}` },
      body: new URLSearchParams({ token: accessToken, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    /* the local tokens are deleted regardless */
  }
}
