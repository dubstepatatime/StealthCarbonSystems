import { and, desc, eq } from 'drizzle-orm'
import { TwoFactorSetup } from '@/components/two-factor'
import { requireUser } from '@/lib/auth/session'
import { effectivePlan, PLANS } from '@/lib/billing/plans'
import { getConnectionView } from '@/lib/coinbase/connection'
import { getDb } from '@/lib/db/client'
import { auditEvents, orders, subscriptions } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { CARET, direction, formatDateTime, formatPrice, formatUsd } from '@/lib/format'
import { getMarketSnapshot } from '@/lib/markets/service'
import { getDeskReport } from '@/lib/trading/desk'
import { ensureAgent, loadPortfolio, platformHalted } from '@/lib/trading/engine'
import { RISK_PROFILES } from '@/lib/trading/limits'
import { HALT_MESSAGES } from '@/lib/trading/risk'
import type { HaltReason } from '@/lib/trading/types'
import { decide, linkCoinbase, manageBilling, runNow, saveSettings, setStatus, signOut, subscribe, unlinkCoinbase } from './actions'

export const metadata = { title: 'Desk — Agentic Trading Desk', robots: { index: false } }

/** Fixed messages for action outcomes. The query string only ever selects one of these. */
const MESSAGES: Record<string, [string, 'ok' | 'error']> = {
  saved: ['Settings saved.', 'ok'], paused: ['Agent paused. No new orders will be placed.', 'ok'], resumed: ['Agent resumed.', 'ok'], ran: ['Run finished. See activity below.', 'ok'],
  decided: ['Decision recorded.', 'ok'], linked: ['Coinbase linked.', 'ok'], unlinked: ['Coinbase unlinked and tokens deleted.', 'ok'], '2fa-on': ['Two-factor authentication is on.', 'ok'],
  halted: ['A circuit breaker stopped the agent.', 'error'], invalid: ['That input was not valid.', 'error'], slow: ['Too many requests. Wait a minute and try again.', 'error'],
  capital: ['That capital amount is outside what your plan allows.', 'error'], 'capital-in-use': ['You cannot remove capital that is invested. Reduce positions first.', 'error'],
  reauth: ['For this change, sign out and sign in again first.', 'error'], 'need-plan': ['Live trading needs a Pilot or Desk subscription.', 'error'], 'need-link': ['Live trading needs a Coinbase link with trade permission.', 'error'],
  'need-2fa': ['Turn on two-factor authentication before trading live.', 'error'], 'need-ack': ['Tick the risk acknowledgement to trade live.', 'error'], 'not-active': ['Resume the agent before running it.', 'error'],
  'no-data': ['Market data is unavailable right now.', 'error'], 'run-error': ['The run failed. Nothing was traded.', 'error'], 'coinbase-off': ['Coinbase linking is not configured on this deployment yet.', 'error'],
  'billing-off': ['Billing is not configured on this deployment yet.', 'error'], 'link-failed': ['The Coinbase link did not complete. Try again.', 'error'], 'link-refused': ['Link refused: Coinbase granted permissions this app does not accept.', 'error'],
  'link-taken': ['That Coinbase account is linked to another user.', 'error'], 'billing-success': ['Thanks. Your plan updates as soon as the payment is confirmed.', 'ok'],
}

const Tag = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <span className={`cds--tag cds--tag--sm cds--tag--${color}`}><span className="cds--tag__label">{children}</span></span>
)
const WORD_COLOR = { BULLISH: 'teal', BEARISH: 'red', NEUTRAL: 'gray' } as const

export default async function DeskPage({ searchParams }: { searchParams: Promise<{ msg?: string; billing?: string }> }) {
  const user = await requireUser()
  const db = await getDb()
  const params = await searchParams
  const message = MESSAGES[params.billing === 'success' ? 'billing-success' : (params.msg ?? '')]

  const agent = await ensureAgent(db, user.id)
  const ledger = agent.mode === 'paper' ? 'paper' : 'live'
  const [[sub], link, halted, portfolio, snapshot, desk, recent, activity] = await Promise.all([
    db.select().from(subscriptions).where(eq(subscriptions.userId, user.id)),
    getConnectionView(db, user.id),
    platformHalted(db),
    loadPortfolio(db, agent.id, ledger),
    getMarketSnapshot().catch(() => null),
    getDeskReport(db).catch(() => null),
    db.select().from(orders).where(and(eq(orders.userId, user.id), eq(orders.agentId, agent.id))).orderBy(desc(orders.createdAt)).limit(12),
    db.select().from(auditEvents).where(eq(auditEvents.userId, user.id)).orderBy(desc(auditEvents.at)).limit(15),
  ])
  const plan = effectivePlan(sub)
  const prices = new Map([...(snapshot?.segments.crypto ?? []), ...(snapshot?.segments.metals ?? [])].map((q) => [q.symbol, q.price]))
  const held = Object.entries(portfolio.positions).map(([id, p]) => ({ id, qty: p.qty.toFixed(), cost: Number(p.costUsd.toFixed(2)), value: prices.get(id) != null ? Number(p.qty.toFixed()) * prices.get(id)! : null }))
  const equity = Number(portfolio.cashUsd.toFixed(2)) + held.reduce((sum, h) => sum + (h.value ?? 0), 0)
  const pending = recent.filter((o) => o.status === 'awaiting_approval')
  const liveReady = plan.liveTrading && link.canTrade && user.twoFactorEnabled

  return (
    <>
      <div className="sc-hero">
        <div className="sc-wrap">
          <p className="sc-eyebrow">Your desk</p>
          <p className="sc-fig sc-fig--lg">{formatUsd(equity)}</p>
          <div className="sc-inline">
            <Tag color={agent.mode === 'paper' ? 'cool-gray' : agent.mode === 'approval' ? 'blue' : 'high-contrast'}>{agent.mode === 'paper' ? 'paper' : agent.mode === 'approval' ? 'approve each trade' : 'automatic'}</Tag>
            <Tag color={agent.status === 'active' ? 'green' : agent.status === 'halted' ? 'red' : 'cool-gray'}>{agent.status}</Tag>
            {halted && <Tag color="red">platform trading stopped</Tag>}
          </div>
          {agent.status === 'halted' && <p className="sc-note sc-note--error">{HALT_MESSAGES[agent.haltReason as HaltReason] ?? 'The agent is halted.'}</p>}
          {message && <p className={`sc-note sc-note--${message[1]}`} role="status">{message[0]}</p>}
          <div className="sc-actions">
            <form action={setStatus}>
              <input type="hidden" name="to" value={agent.status === 'active' ? 'paused' : 'active'} />
              <button className={`cds--btn ${agent.status === 'active' ? 'cds--btn--danger' : 'cds--btn--primary'}`}>{agent.status === 'active' ? 'Pause agent' : 'Resume agent'}</button>
            </form>
            <form action={runNow}><button className="cds--btn cds--btn--tertiary" disabled={agent.status !== 'active'}>Run now</button></form>
            <form action={signOut}><button className="cds--btn cds--btn--ghost">Sign out</button></form>
          </div>
        </div>
      </div>

      {pending.length > 0 && (
        <section className="sc-section">
          <div className="sc-wrap">
            <h2 className="sc-h2">Waiting for you</h2>
            <p className="sc-intro">Each proposal is re-checked against current prices and your limits when you approve it.</p>
            <div className="sc-grid">
              {pending.map((o) => (
                <div key={o.id} className="sc-tile">
                  <p className="sc-tile__title">{o.side === 'BUY' ? 'Buy' : 'Sell'} {formatUsd(o.notionalUsd)} of {o.productId}</p>
                  <p className="sc-body">{o.reason} Limit {o.limitPrice ? formatPrice(Number(o.limitPrice)) : '—'}.</p>
                  <form action={decide} className="sc-inline">
                    <input type="hidden" name="orderId" value={o.id} />
                    <button className="cds--btn cds--btn--primary cds--btn--sm" name="approve" value="yes">Approve</button>
                    <button className="cds--btn cds--btn--ghost cds--btn--sm" name="approve" value="no">Decline</button>
                  </form>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="sc-section">
        <div className="sc-wrap sc-grid">
          <div className="sc-tile">
            <div className="sc-tile__head">
              <div>
                <h2 className="sc-tile__title">Desk signals</h2>
                <p className="sc-tile__desc">{desk ? `${desk.report.source === 'ai+quant' ? 'Rules, tilted by the AI analyst' : 'Rules only'} · as of ${formatDateTime(desk.report.asOf)}` : 'Unavailable'}</p>
              </div>
              {desk && <Tag color={desk.report.regime === 'risk_on' ? 'teal' : desk.report.regime === 'risk_off' ? 'red' : 'gray'}>{desk.report.regime.replace('_', '-')}</Tag>}
            </div>
            {desk ? (
              <>
                <p className="sc-body">{desk.report.source === 'ai+quant' && <Tag color="blue">AI</Tag>} {desk.report.narrative}</p>
                <div>
                  {desk.report.signals.map((s) => (
                    <div key={s.productId} className="sc-row">
                      <span className="sc-row__name">{s.productId}</span>
                      <span className="sc-figs"><span className="sc-fig">{s.conviction.toFixed(2).replace("-", "−")}</span><Tag color={WORD_COLOR[s.word]}>{s.word}</Tag></span>
                    </div>
                  ))}
                </div>
                <p className="sc-legal">Informational only — not financial advice.</p>
              </>
            ) : <p className="sc-body">Market history could not be loaded. The agent does not trade without fresh signals.</p>}
          </div>

          <div className="sc-tile">
            <div>
              <h2 className="sc-tile__title">{ledger === 'paper' ? 'Paper book' : 'Agent book'}</h2>
              <p className="sc-tile__desc">Only what the agent itself bought. It never sells anything else in your account.</p>
            </div>
            <div>
              <div className="sc-row"><span className="sc-row__name">Cash</span><span className="sc-fig">{formatUsd(portfolio.cashUsd.toFixed(2))}</span></div>
              {held.map((h) => {
                const dir = direction(h.value == null ? null : h.value - h.cost)
                return (
                  <div key={h.id} className="sc-row">
                    <span><span className="sc-row__name">{h.id}</span><span className="sc-row__symbol">{h.qty}</span></span>
                    <span className={`sc-fig sc-${dir}`}><span aria-hidden="true">{CARET[dir]} </span>{h.value == null ? '—' : formatUsd(h.value)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="sc-section">
        <div className="sc-wrap sc-grid">
          <div className="sc-tile">
            <h2 className="sc-tile__title">Agent settings</h2>
            <form action={saveSettings} className="sc-form">
              <div className="sc-field">
                <label htmlFor="capital">Capital the agent may use (USD, up to {formatUsd(plan.maxCapitalUsd)})</label>
                <input className="sc-input" id="capital" name="capital" inputMode="decimal" pattern="\d{1,7}(\.\d{1,2})?" defaultValue={agent.policy.capitalUsd} required />
              </div>
              <div className="sc-field">
                <label htmlFor="profile">Risk profile</label>
                <select className="sc-select" id="profile" name="profile" defaultValue={agent.riskProfile}>{RISK_PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
              </div>
              <div className="sc-field">
                <label htmlFor="mode">Mode</label>
                <select className="sc-select" id="mode" name="mode" defaultValue={agent.mode}>
                  <option value="paper">Paper — simulated fills, no real orders</option>
                  <option value="approval" disabled={!liveReady}>Approve each trade — real orders after your OK</option>
                  <option value="auto" disabled={!liveReady}>Automatic — real orders inside your limits</option>
                </select>
              </div>
              {!agent.riskAcknowledgedAt && (
                <label className="sc-body"><input type="checkbox" name="acknowledge" /> I understand that automated trading can lose money, that limits reduce risk but do not remove it, and that I am responsible for the orders placed in my account.</label>
              )}
              <div><button className="cds--btn cds--btn--primary cds--btn--sm">Save settings</button></div>
            </form>
            <dl className="sc-kv">
              <dt>Largest order</dt><dd className="sc-fig">{formatUsd(agent.policy.maxOrderUsd)}</dd>
              <dt>Most in one asset</dt><dd className="sc-fig">{agent.policy.maxPositionPct}%</dd>
              <dt>Most invested</dt><dd className="sc-fig">{agent.policy.maxExposurePct}%</dd>
              <dt>Daily loss stop</dt><dd className="sc-fig">{agent.policy.dailyLossLimitPct}%</dd>
              <dt>Drawdown stop</dt><dd className="sc-fig">{agent.policy.maxDrawdownPct}%</dd>
              <dt>Price collar</dt><dd className="sc-fig">{agent.policy.maxSlippageBps} bps</dd>
              <dt>Products</dt><dd className="sc-fig">{agent.policy.universe.join(' ')}</dd>
            </dl>
          </div>

          <div className="sc-tile">
            <div className="sc-tile__head"><h2 className="sc-tile__title">Coinbase</h2><Tag color={link.linked && !link.needsReauth ? 'green' : 'cool-gray'}>{link.needsReauth ? 'Link expired' : link.linked ? 'Linked' : 'Not linked'}</Tag></div>
            <p className="sc-body">The link carries trade and read permissions only. It cannot send, withdraw or transfer, and you can revoke it here or in your Coinbase security settings at any time.</p>
            {!env.coinbase() && <p className="sc-note">Setup required: Coinbase must approve this app as an OAuth client before accounts can be linked. Paper trading works without it.</p>}
            <div className="sc-inline">
              <form action={linkCoinbase}><button className="cds--btn cds--btn--tertiary cds--btn--sm" disabled={!env.coinbase()}>{link.linked ? 'Link again' : 'Link Coinbase account'}</button></form>
              {link.linked && <form action={unlinkCoinbase}><button className="cds--btn cds--btn--danger--tertiary cds--btn--sm">Disconnect</button></form>}
            </div>

            <div className="sc-tile__head"><h2 className="sc-tile__title">Plan</h2><Tag color={plan.id === 'free' ? 'cool-gray' : 'green'}>{plan.name}</Tag></div>
            <p className="sc-body">{plan.tagline}{sub?.cancelAtPeriodEnd ? ' Your plan ends at the close of this billing period.' : ''}</p>
            <div className="sc-inline">
              {plan.id === 'free' ? (['pilot', 'desk'] as const).map((id) => (
                <form key={id} action={subscribe}><input type="hidden" name="plan" value={id} /><button className="cds--btn cds--btn--tertiary cds--btn--sm">{PLANS[id].name} · ${PLANS[id].priceUsd}/mo</button></form>
              )) : <form action={manageBilling}><button className="cds--btn cds--btn--tertiary cds--btn--sm">Manage or cancel</button></form>}
            </div>

            <div className="sc-tile__head"><h2 className="sc-tile__title">Two-factor</h2><Tag color={user.twoFactorEnabled ? 'green' : 'cool-gray'}>{user.twoFactorEnabled ? 'On' : 'Off'}</Tag></div>
            {user.twoFactorEnabled ? <p className="sc-body">Sign-in asks for a code from your authenticator app.</p> : <TwoFactorSetup />}
          </div>
        </div>
      </section>

      <section className="sc-section">
        <div className="sc-wrap sc-grid">
          <div className="sc-tile">
            <h2 className="sc-tile__title">Orders</h2>
            <div>
              {recent.length === 0 && <p className="sc-body">No orders yet. The agent trades only when a position is far enough from its target.</p>}
              {recent.map((o) => (
                <div key={o.id} className="sc-row">
                  <span><span className="sc-row__name">{o.side === 'BUY' ? 'Buy' : 'Sell'} {o.productId}</span><span className="sc-row__symbol">{formatDateTime(o.createdAt)}</span></span>
                  <span className="sc-figs"><span className="sc-fig">{formatUsd(o.notionalUsd)}</span><Tag color={o.status === 'filled' ? 'green' : o.status === 'rejected' || o.status === 'failed' ? 'red' : 'cool-gray'}>{o.status.replace(/_/g, ' ')}</Tag></span>
                </div>
              ))}
            </div>
          </div>
          <div className="sc-tile">
            <h2 className="sc-tile__title">Activity</h2>
            <div>
              {activity.length === 0 && <p className="sc-body">Nothing yet.</p>}
              {activity.map((e) => (
                <div key={e.id} className="sc-row"><span className="sc-body">{e.summary}</span><span className="sc-row__symbol">{formatDateTime(e.at)}</span></div>
              ))}
            </div>
          </div>
        </div>
        <div className="sc-wrap"><p className="sc-legal">Automated trading can lose money. Limits reduce risk; they do not remove it. Informational only — not financial advice.</p></div>
      </section>
    </>
  )
}
