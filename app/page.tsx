import Link from 'next/link'
import { Markets } from '@/components/markets'
import { PLANS } from '@/lib/billing/plans'
import { env } from '@/lib/env'
import { getMarketSnapshot } from '@/lib/markets/service'

const SAFEGUARDS = [
  ['It cannot move your money', 'The Coinbase link is granted trade and read permissions only. It has no permission to send, withdraw or transfer, and the app refuses a link that carries one.'],
  ['Every order passes fixed limits', 'Order size, position size, total exposure, daily loss, drawdown, price collars and a product allow-list are checked by code, not by the model. The model can lean a signal; it cannot place an order.'],
  ['You hold the stop', 'Pause the agent at any time. A daily loss or drawdown limit stops it automatically, and it stays stopped until you resume it.'],
  ['Paper first', 'The agent starts in paper mode with simulated fills on real prices. Live trading needs a subscription, two-factor authentication and your written acknowledgement of the risk.'],
]

export default async function Page() {
  const snapshot = await getMarketSnapshot().catch(() => null)
  // Paid plans promise live trading, which needs the Coinbase link. Until that is configured, show only what works.
  const liveAvailable = Boolean(env.coinbase())
  const plans = Object.values(PLANS).filter((plan) => liveAvailable || !plan.liveTrading)
  return (
    <>
      <div className="sc-hero">
        <div className="sc-wrap">
          <p className="sc-eyebrow">Agentic Trading Desk</p>
          <h1 className="sc-title">An AI agent that trades your Coinbase account inside limits you set</h1>
          <p className="sc-lead">It reads US, global, crypto and precious-metals markets, then rebalances a small set of liquid assets for you. You set the capital and the limits. It works within them.</p>
          <div className="sc-actions">
            <Link className="cds--btn cds--btn--primary" href="/sign-in?mode=create">Start with paper trading</Link>
            <span className="cds--tag cds--tag--green"><span className="cds--tag__label">Live data</span></span>
          </div>
        </div>
      </div>

      <section className="sc-section">
        <div className="sc-wrap">
          <h2 className="sc-h2">Live markets</h2>
          <p className="sc-intro">The same feeds the agent reads.</p>
          <Markets initial={snapshot} />
        </div>
      </section>

      <section className="sc-section">
        <div className="sc-wrap">
          <h2 className="sc-h2">How it stays inside the lines</h2>
          <p className="sc-intro">Automation is only useful if you can bound what it does.</p>
          <div className="sc-grid sc-grid--4">
            {SAFEGUARDS.map(([title, body]) => (
              <div key={title} className="sc-tile">
                <h3 className="sc-tile__title">{title}</h3>
                <p className="sc-body">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sc-section">
        <div className="sc-wrap">
          <h2 className="sc-h2">Plans</h2>
          <p className="sc-intro">{liveAvailable ? 'A flat monthly fee. No share of profits, no fee on trades. Cancel online at any time.' : 'Paper trading is free. Live trading is not open yet.'}</p>
          <div className="sc-grid sc-grid--3">
            {plans.map((plan) => (
              <div key={plan.id} className="sc-tile">
                <div>
                  <h3 className="sc-tile__title">{plan.name}</h3>
                  <p className="sc-tile__desc">{plan.tagline}</p>
                </div>
                <p className="sc-plan__price">{plan.priceUsd === 0 ? 'Free' : `$${plan.priceUsd}/mo`}</p>
                <ul className="sc-list">{plan.features.map((f) => <li key={f}>{f}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="sc-footer">
        <div className="sc-wrap">
          <p className="sc-legal">
            Automated trading can lose money. Limits reduce risk; they do not remove it. Past and simulated results do not predict future results. Nothing here is investment, legal or tax advice. Informational only — not financial advice. Crypto assets are volatile and you can lose all the capital you allocate. The service is not affiliated with Coinbase.
          </p>
        </div>
      </footer>
    </>
  )
}
