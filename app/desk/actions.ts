'use server'

/**
 * Every state change on the desk. Each action re-checks who is asking,
 * validates its input, acts only on that person's rows, and writes an audit
 * event. Outcomes are reported with fixed message codes, never echoed input.
 */
import { and, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { getAuth } from '@/lib/auth/server'
import { requireUser } from '@/lib/auth/session'
import { effectivePlan } from '@/lib/billing/plans'
import { createCheckout, createPortal } from '@/lib/billing/stripe'
import { disconnect, getConnectionView } from '@/lib/coinbase/connection'
import { REQUESTED_SCOPES, startAuthorization } from '@/lib/coinbase/oauth'
import { getDb } from '@/lib/db/client'
import { agents, ledgers, oauthStates, subscriptions } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { audit } from '@/lib/security/audit'
import { seal, sha256 } from '@/lib/security/crypto'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipHash } from '@/lib/security/request'
import { getDeskReport } from '@/lib/trading/desk'
import { decideOrder, ensureAgent, runAgentTick } from '@/lib/trading/engine'
import { defaultPolicy, parseRiskPolicy, PolicyError, RISK_PROFILES } from '@/lib/trading/limits'
import { dec, toDecimalString } from '@/lib/trading/money'

const RISK_DISCLOSURE_VERSION = '2026-11'

const done = (code: string): never => redirect(`/desk?msg=${code}`)

async function context() {
  const user = await requireUser()
  const db = await getDb()
  const h = await headers()
  const limit = await rateLimit(db, `action:${user.id}`, 60, 60)
  if (!limit.ok) done('slow')
  return { user, db, ip: ipHash(h), agent: await ensureAgent(db, user.id) }
}

export async function setStatus(formData: FormData) {
  const { user, db, agent, ip } = await context()
  const to = z.enum(['active', 'paused']).parse(formData.get('to'))
  await db.update(agents).set({ status: to, haltReason: null, nextRunAt: to === 'active' ? new Date() : agent.nextRunAt, leaseUntil: null }).where(and(eq(agents.id, agent.id), eq(agents.userId, user.id)))
  await audit(db, { userId: user.id, actor: 'user', action: to === 'active' ? 'agent.resumed' : 'agent.paused', summary: to === 'active' ? 'Agent resumed.' : 'Agent paused. No new orders will be placed.', ipHash: ip })
  done(to === 'active' ? 'resumed' : 'paused')
}

const settingsSchema = z.object({
  profile: z.enum(RISK_PROFILES as [string, ...string[]]),
  capital: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/),
  mode: z.enum(['paper', 'approval', 'auto']),
  acknowledge: z.literal('on').optional(),
})

export async function saveSettings(formData: FormData) {
  const { user, db, agent, ip } = await context()
  const parsed = settingsSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) done('invalid')
  const input = parsed.data!
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id))
  const plan = effectivePlan(sub)

  let policy
  try {
    policy = parseRiskPolicy(defaultPolicy(input.profile as (typeof RISK_PROFILES)[number], input.capital), plan.maxCapitalUsd)
  } catch (err) {
    done(err instanceof PolicyError && err.field === 'capitalUsd' ? 'capital' : 'invalid')
  }

  const acknowledgedAt = agent.riskAcknowledgedAt ?? (input.acknowledge ? new Date() : null)
  if (input.mode !== 'paper') {
    // Going live changes what the agent can do with real money: require a recent sign-in and every prerequisite.
    if (!user.fresh) done('reauth')
    const link = await getConnectionView(db, user.id)
    if (!plan.liveTrading) done('need-plan')
    if (!link.canTrade) done('need-link')
    if (!user.twoFactorEnabled) done('need-2fa')
    if (!acknowledgedAt) done('need-ack')
  }

  const delta = dec(policy!.capitalUsd).minus(agent.policy.capitalUsd)
  if (!delta.eq(0)) {
    // Capital is added to or taken from the agent's cash on every book; it cannot take out more cash than a book holds.
    const books = await db.select().from(ledgers).where(eq(ledgers.agentId, agent.id))
    if (books.some((b) => dec(b.cashUsd).plus(delta).lt(0))) done('capital-in-use')
    for (const b of books) {
      await db.update(ledgers).set({ cashUsd: toDecimalString(dec(b.cashUsd).plus(delta)), peakEquityUsd: toDecimalString(dec(b.peakEquityUsd).plus(delta)), dayStartEquityUsd: toDecimalString(dec(b.dayStartEquityUsd).plus(delta)) }).where(and(eq(ledgers.agentId, agent.id), eq(ledgers.ledger, b.ledger)))
    }
  }
  await db
    .update(agents)
    .set({ policy: policy!, riskProfile: input.profile as (typeof RISK_PROFILES)[number], mode: input.mode, cadenceMinutes: plan.minCadenceMinutes, riskAcknowledgedAt: acknowledgedAt, riskDisclosureVersion: acknowledgedAt ? RISK_DISCLOSURE_VERSION : null })
    .where(and(eq(agents.id, agent.id), eq(agents.userId, user.id)))
  await audit(db, { userId: user.id, actor: 'user', action: 'agent.settings.changed', summary: `Settings saved: ${input.mode} mode, ${input.profile} profile, $${policy!.capitalUsd} capital.`, metadata: { mode: input.mode, profile: input.profile, capitalUsd: policy!.capitalUsd }, ipHash: ip })
  done('saved')
}

export async function runNow() {
  const { user, db, agent } = await context()
  const limit = await rateLimit(db, `run:${user.id}`, 6, 3600)
  if (!limit.ok) done('slow')
  if (agent.status !== 'active') done('not-active')
  const desk = await getDeskReport(db).catch(() => null)
  if (!desk) done('no-data')
  const result = await runAgentTick(db, agent.id, desk!)
  done(result.outcome === 'error' ? 'run-error' : result.outcome === 'halted' ? 'halted' : 'ran')
}

export async function decide(formData: FormData) {
  const { user, db } = await context()
  const input = z.object({ orderId: z.string().uuid(), approve: z.enum(['yes', 'no']) }).safeParse(Object.fromEntries(formData))
  if (!input.success) done('invalid')
  await decideOrder(db, user.id, input.data!.orderId, input.data!.approve === 'yes')
  done('decided')
}

export async function linkCoinbase() {
  const { user, db } = await context()
  if (!env.coinbase()) done('coinbase-off')
  if (!user.fresh) done('reauth')
  const { url, state, codeVerifier } = startAuthorization()
  await db.insert(oauthStates).values({ stateHash: sha256(state), userId: user.id, codeVerifierEnc: seal(codeVerifier, `oauth:${user.id}`), scopes: REQUESTED_SCOPES.join(' '), expiresAt: new Date(Date.now() + 10 * 60_000) })
  redirect(url)
}

export async function unlinkCoinbase() {
  const { user, db, agent } = await context()
  await disconnect(db, user.id)
  // Without a link the agent cannot trade live: fall back to paper.
  if (agent.mode !== 'paper') await db.update(agents).set({ mode: 'paper' }).where(and(eq(agents.id, agent.id), eq(agents.userId, user.id)))
  done('unlinked')
}

export async function subscribe(formData: FormData) {
  const { user, db } = await context()
  const plan = z.enum(['pilot', 'desk']).parse(formData.get('plan'))
  // Paid plans are not sold while live trading is unavailable.
  if (!env.coinbase()) done('billing-off')
  const url = await createCheckout(db, user, plan).catch(() => null)
  if (!url) done('billing-off')
  redirect(url!)
}

export async function manageBilling() {
  const { user, db } = await context()
  const url = await createPortal(db, user.id).catch(() => null)
  if (!url) done('billing-off')
  redirect(url!)
}

export async function signOut() {
  const auth = await getAuth()
  await auth.api.signOut({ headers: await headers() })
  redirect('/')
}
