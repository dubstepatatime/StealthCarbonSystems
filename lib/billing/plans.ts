/** Plans and what each one unlocks. Prices here are display values; Stripe holds the real ones. */
export type PlanId = 'free' | 'pilot' | 'desk'

export interface Plan {
  id: PlanId
  name: string
  priceUsd: number
  tagline: string
  liveTrading: boolean
  /** Most capital the agent may manage. */
  maxCapitalUsd: number
  /** Shortest time between agent runs, in minutes. */
  minCadenceMinutes: number
  features: string[]
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', name: 'Observer', priceUsd: 0, tagline: 'Watch the desk and paper trade.', liveTrading: false, maxCapitalUsd: 100_000, minCadenceMinutes: 1440, features: ['Live markets across four segments', 'Daily desk signals', 'Paper-trading agent with full risk limits'] },
  pilot: { id: 'pilot', name: 'Pilot', priceUsd: 19, tagline: 'Let the agent trade a small account.', liveTrading: true, maxCapitalUsd: 2_500, minCadenceMinutes: 1440, features: ['Everything in Observer', 'Live trading on your Coinbase account', 'Up to $2,500 managed', 'One run per day', 'Approve-each-trade or automatic mode'] },
  desk: { id: 'desk', name: 'Desk', priceUsd: 49, tagline: 'More capital, more frequent runs.', liveTrading: true, maxCapitalUsd: 25_000, minCadenceMinutes: 240, features: ['Everything in Pilot', 'Up to $25,000 managed', 'A run every four hours'] },
}

const ACTIVE = new Set(['active', 'trialing'])

/** The plan a subscription row actually entitles someone to. Anything not clearly active is Observer. */
export function effectivePlan(sub: { plan: PlanId; status: string } | null | undefined): Plan {
  if (!sub || !ACTIVE.has(sub.status)) return PLANS.free
  return PLANS[sub.plan] ?? PLANS.free
}
