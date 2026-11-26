/**
 * Server configuration. Read lazily (never at import) so a build without
 * secrets succeeds, and fail closed in production: a missing secret disables
 * the feature that needs it instead of falling back to a default.
 */
import 'server-only'

export const isProd = () => process.env.NODE_ENV === 'production'

export class ConfigError extends Error {
  constructor(name: string) {
    super(`${name} is not configured`)
    this.name = 'ConfigError'
  }
}

const opt = (name: string): string | undefined => {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

/** A secret that must exist in production. Development gets a fixed, clearly fake value. */
function secret(name: string, minLength: number): string {
  const v = opt(name)
  if (v) {
    if (v.length < minLength) throw new ConfigError(`${name} (too short)`)
    return v
  }
  if (isProd()) throw new ConfigError(name)
  return `dev-only-${name}-not-a-secret-0123456789abcdef`
}

export const env = {
  appUrl(): string {
    const v = opt('APP_URL') ?? (opt('VERCEL_PROJECT_PRODUCTION_URL') ? `https://${opt('VERCEL_PROJECT_PRODUCTION_URL')}` : undefined)
    if (v) return new URL(v).origin
    if (isProd()) throw new ConfigError('APP_URL')
    return 'http://localhost:3000'
  },
  authSecret: () => secret('BETTER_AUTH_SECRET', 32),
  /** Key material for encrypting exchange tokens at rest. Keep it out of the database. */
  tokenKey: () => secret('TOKEN_ENCRYPTION_KEY', 32),
  cronSecret: () => secret('CRON_SECRET', 24),
  coinbase(): { clientId: string; clientSecret: string } | null {
    const clientId = opt('COINBASE_CLIENT_ID')
    const clientSecret = opt('COINBASE_CLIENT_SECRET')
    return clientId && clientSecret ? { clientId, clientSecret } : null
  },
  stripe(): { secretKey: string; webhookSecret: string; prices: { pilot?: string; desk?: string } } | null {
    const secretKey = opt('STRIPE_SECRET_KEY')
    const webhookSecret = opt('STRIPE_WEBHOOK_SECRET')
    if (!secretKey || !webhookSecret) return null
    return { secretKey, webhookSecret, prices: { pilot: opt('STRIPE_PRICE_PILOT'), desk: opt('STRIPE_PRICE_DESK') } }
  },
  aiEnabled: () => Boolean(opt('AI_GATEWAY_API_KEY') || opt('VERCEL_OIDC_TOKEN')),
  aiModel: () => opt('AI_MODEL') ?? 'anthropic/claude-sonnet-4.6',
  /** Operator kill switch. Any value other than "0"/"false" stops all trading. */
  tradingHalted(): boolean {
    const v = opt('TRADING_HALTED')
    return v !== undefined && v !== '0' && v.toLowerCase() !== 'false'
  },
}
