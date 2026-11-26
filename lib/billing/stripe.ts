/**
 * Stripe Billing. Card data never touches this server: checkout and plan
 * changes happen on Stripe's hosted pages. Entitlements come only from
 * signature-verified webhooks, never from a redirect back to the site.
 */
import 'server-only'
import { eq } from 'drizzle-orm'
import Stripe from 'stripe'
import type { Db } from '@/lib/db/client'
import { billingEvents, subscriptions } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { audit } from '@/lib/security/audit'
import type { PlanId } from './plans'

let client: Stripe | undefined
export function stripe(): Stripe | null {
  const cfg = env.stripe()
  if (!cfg) return null
  client ??= new Stripe(cfg.secretKey, { maxNetworkRetries: 2, timeout: 10_000, appInfo: { name: 'agentic-trading-desk' } })
  return client
}

export function planForPrice(priceId: string | null | undefined): PlanId {
  const prices = env.stripe()?.prices
  if (priceId && prices?.pilot === priceId) return 'pilot'
  if (priceId && prices?.desk === priceId) return 'desk'
  return 'free'
}

export async function createCheckout(db: Db, user: { id: string; email: string }, plan: Exclude<PlanId, 'free'>): Promise<string> {
  const s = stripe()
  const price = env.stripe()?.prices[plan]
  if (!s || !price) throw new Error('Billing is not configured')
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id))
  // Someone who already has a subscription changes it in the billing portal; a second checkout would bill them twice.
  if (row?.stripeSubscriptionId && !['canceled', 'incomplete_expired', 'none'].includes(row.status)) return createPortal(db, user.id)
  let customerId = row?.stripeCustomerId ?? null
  if (!customerId) {
    const customer = await s.customers.create({ email: user.email, metadata: { userId: user.id } }, { idempotencyKey: `customer-${user.id}` })
    customerId = customer.id
    await db.insert(subscriptions).values({ userId: user.id, stripeCustomerId: customerId }).onConflictDoUpdate({ target: subscriptions.userId, set: { stripeCustomerId: customerId } })
  }
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    success_url: `${env.appUrl()}/desk?billing=success`,
    cancel_url: `${env.appUrl()}/desk?billing=cancelled`,
    subscription_data: { metadata: { userId: user.id } },
  })
  if (!session.url) throw new Error('Stripe did not return a checkout URL')
  return session.url
}

export async function createPortal(db: Db, userId: string): Promise<string> {
  const s = stripe()
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId))
  if (!s || !row?.stripeCustomerId) throw new Error('No billing account')
  const session = await s.billingPortal.sessions.create({ customer: row.stripeCustomerId, return_url: `${env.appUrl()}/desk` })
  return session.url
}

/** Copy the customer's current subscription from Stripe into our table. Stripe is the source of truth. */
export async function syncCustomer(db: Db, customerId: string): Promise<void> {
  const s = stripe()
  if (!s) return
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.stripeCustomerId, customerId))
  if (!row) return
  const list = await s.subscriptions.list({ customer: customerId, status: 'all', limit: 5 })
  const sub = list.data.find((x) => x.status === 'active' || x.status === 'trialing') ?? list.data[0]
  if (!sub) {
    await db.update(subscriptions).set({ plan: 'free', status: 'none', stripeSubscriptionId: null, priceId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false }).where(eq(subscriptions.userId, row.userId))
    return
  }
  const item = sub.items.data[0]
  // The period end moved from the subscription to its items in newer API versions; read either.
  const periodEnd = (item as unknown as { current_period_end?: number } | undefined)?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end
  const plan = planForPrice(item?.price.id)
  await db
    .update(subscriptions)
    .set({ plan, status: sub.status, stripeSubscriptionId: sub.id, priceId: item?.price.id ?? null, currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null, cancelAtPeriodEnd: sub.cancel_at_period_end })
    .where(eq(subscriptions.userId, row.userId))
  await audit(db, { userId: row.userId, actor: 'system', action: 'billing.synced', summary: `Subscription is ${sub.status} on the ${plan} plan.` })
}

const HANDLED = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.paid', 'invoice.payment_failed'])

/** Verify and process one webhook delivery. Returns the HTTP status to answer with. */
export async function handleWebhook(db: Db, rawBody: string, signature: string | null): Promise<number> {
  const s = stripe()
  const cfg = env.stripe()
  if (!s || !cfg) return 503
  if (!signature) return 400
  let event: Stripe.Event
  try {
    event = await s.webhooks.constructEventAsync(rawBody, signature, cfg.webhookSecret)
  } catch {
    return 400
  }
  // The primary key makes a replayed event a no-op.
  const inserted = await db.insert(billingEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning({ id: billingEvents.id })
  if (inserted.length === 0) return 200
  if (HANDLED.has(event.type)) {
    const customer = (event.data.object as { customer?: string | { id: string } | null }).customer
    const customerId = typeof customer === 'string' ? customer : customer?.id
    try {
      if (customerId) await syncCustomer(db, customerId)
    } catch {
      // Forget the event so Stripe's retry processes it; answering 200 here would lose the change.
      await db.delete(billingEvents).where(eq(billingEvents.id, event.id))
      return 500
    }
  }
  await db.update(billingEvents).set({ processedAt: new Date() }).where(eq(billingEvents.id, event.id))
  return 200
}
