import { describe, expect, it } from 'vitest'
import { effectivePlan } from '@/lib/billing/plans'
import { canTrade, REQUESTED_SCOPES, startAuthorization, unexpectedScopes } from '@/lib/coinbase/oauth'
import { redact } from '@/lib/security/audit'
import { open, safeEqual, seal } from '@/lib/security/crypto'
import { rateLimit } from '@/lib/security/rate-limit'
import { freshDb } from './db/helpers'

describe('token vault', () => {
  it('round-trips, never repeats a ciphertext, and rejects tampering or the wrong owner', () => {
    const a = seal('secret-token', 'coinbase:access:u1')
    expect(a).not.toContain('secret-token')
    expect(seal('secret-token', 'coinbase:access:u1')).not.toBe(a)
    expect(open(a, 'coinbase:access:u1')).toBe('secret-token')
    expect(() => open(a, 'coinbase:access:u2')).toThrow()
    const parts = a.split('.')
    parts[2] = parts[2]!.slice(0, -2) + (parts[2]!.endsWith('AA') ? 'BB' : 'AA')
    expect(() => open(parts.join('.'), 'coinbase:access:u1')).toThrow()
    expect(() => open('garbage', 'x')).toThrow()
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })
})

describe('coinbase scopes', () => {
  it('never asks for a scope that can move money', () => {
    for (const s of REQUESTED_SCOPES) expect(s).not.toMatch(/send|withdraw|transfer|deposit|payment|address|request|trades|accounts:(create|update|delete)|user:update/)
  })
  it('flags anything granted beyond the request', () => {
    expect(unexpectedScopes([...REQUESTED_SCOPES])).toEqual([])
    expect(unexpectedScopes(['wallet:accounts:read', 'wallet:transactions:send'])).toEqual(['wallet:transactions:send'])
    expect(canTrade(['wallet:accounts:read'])).toBe(false)
  })
  it('builds a PKCE S256 authorization URL with unguessable state', () => {
    process.env.COINBASE_CLIENT_ID = 'id'
    process.env.COINBASE_CLIENT_SECRET = 'secret'
    const a = startAuthorization()
    const b = startAuthorization()
    const url = new URL(a.url)
    expect(url.origin + url.pathname).toBe('https://login.coinbase.com/oauth2/auth')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).not.toBe(a.codeVerifier)
    expect(a.state.length).toBeGreaterThanOrEqual(40)
    expect(a.state).not.toBe(b.state)
    expect(a.url).not.toContain('secret')
  })
})

describe('entitlements, audit, rate limit', () => {
  it('treats anything but an active subscription as the free plan', () => {
    expect(effectivePlan(null).liveTrading).toBe(false)
    for (const status of ['canceled', 'past_due', 'unpaid', 'incomplete', 'paused', 'none']) expect(effectivePlan({ plan: 'desk', status }).id).toBe('free')
    expect(effectivePlan({ plan: 'pilot', status: 'active' }).liveTrading).toBe(true)
  })
  it('redacts secrets from audit metadata', () => {
    expect(redact({ accessToken: 'x', nested: { password: 'y', ok: 1 }, code: 'z' })).toEqual({ accessToken: '[redacted]', nested: { password: '[redacted]', ok: 1 }, code: '[redacted]' })
  })
  it('limits by key and window', async () => {
    const db = await freshDb()
    const now = new Date('2026-11-26T12:00:10Z')
    for (let i = 0; i < 3; i++) expect((await rateLimit(db, 'k', 3, 60, now)).ok).toBe(true)
    expect((await rateLimit(db, 'k', 3, 60, now)).ok).toBe(false)
    expect((await rateLimit(db, 'other', 3, 60, now)).ok).toBe(true)
    expect((await rateLimit(db, 'k', 3, 60, new Date('2026-11-26T12:01:05Z'))).ok).toBe(true)
  })
})
