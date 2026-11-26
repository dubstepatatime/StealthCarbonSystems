/**
 * Authentication (Better Auth): email and password, database sessions in
 * HttpOnly cookies, TOTP two-factor, and rate limits on every auth endpoint.
 */
import 'server-only'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { nextCookies } from 'better-auth/next-js'
import { twoFactor } from 'better-auth/plugins/two-factor'
import { getDb } from '@/lib/db/client'
import { account, rateLimit, session, twoFactor as twoFactorTable, user, verification } from '@/lib/db/schema'
import { env, isProd } from '@/lib/env'

export const MIN_PASSWORD_LENGTH = 12
/** A session younger than this may perform sensitive actions without re-entering the password. */
export const FRESH_SESSION_SECONDS = 10 * 60

async function build() {
  const db = await getDb()
  return betterAuth({
    appName: 'Agentic Trading Desk',
    baseURL: env.appUrl(),
    secret: env.authSecret(),
    trustedOrigins: [env.appUrl()],
    database: drizzleAdapter(db, { provider: 'pg', schema: { user, session, account, verification, twoFactor: twoFactorTable, rateLimit } }),
    emailAndPassword: { enabled: true, minPasswordLength: MIN_PASSWORD_LENGTH, maxPasswordLength: 128, autoSignIn: true },
    session: { expiresIn: 7 * 24 * 3600, updateAge: 24 * 3600, freshAge: FRESH_SESSION_SECONDS },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 3600, max: 5 },
        '/two-factor/*': { window: 60, max: 5 },
      },
    },
    advanced: { useSecureCookies: isProd(), cookiePrefix: 'sc' },
    plugins: [twoFactor({ issuer: 'Agentic Trading Desk' }), nextCookies()],
  })
}

type Auth = Awaited<ReturnType<typeof build>>
const g = globalThis as unknown as { __scAuth?: Promise<Auth> }

export function getAuth(): Promise<Auth> {
  if (!g.__scAuth) {
    g.__scAuth = build()
    g.__scAuth.catch(() => {
      g.__scAuth = undefined
    })
  }
  return g.__scAuth
}
