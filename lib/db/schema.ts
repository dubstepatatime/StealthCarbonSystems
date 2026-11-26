/**
 * Database schema (PostgreSQL via Drizzle).
 *
 * Conventions
 * - Money and quantities are numeric(38,18) and travel as decimal strings.
 * - Every row that belongs to a person carries user_id and is only ever read
 *   through a query that filters on it (see lib/db/queries).
 * - Secrets (exchange tokens, OAuth verifiers) are stored encrypted; the
 *   columns end in `Enc`. Nothing here is readable without the key that lives
 *   outside the database.
 * - audit_events is append-only, enforced by a trigger in the migrations.
 */
import { sql } from 'drizzle-orm'
import { bigint, bigserial, boolean, check, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import type { AgentMode, AgentStatus, Ledger, OrderStatus, Regime, RiskCheck, RiskPolicy, RiskProfile, Side } from '@/lib/trading/types'

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const createdAt = () => ts('created_at').notNull().defaultNow()
const updatedAt = () =>
  ts('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
const money = (name: string) => numeric(name, { precision: 38, scale: 18 })

// ---------------------------------------------------------------------------
// Authentication (table and field names are what Better Auth 1.7 expects)
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: ts('expires_at').notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    /** Password hash for the email-and-password provider. */
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

export const twoFactor = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: ts('locked_until'),
  },
  (t) => [index('two_factor_user_idx').on(t.userId), index('two_factor_secret_idx').on(t.secret)],
)

/** Better Auth's own limiter for its endpoints. */
export const rateLimit = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
})

// ---------------------------------------------------------------------------
// The agent and its books
// ---------------------------------------------------------------------------

export const agents = pgTable(
  'agents',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<AgentMode>().notNull().default('paper'),
    status: text('status').$type<AgentStatus>().notNull().default('paused'),
    haltReason: text('halt_reason'),
    riskProfile: text('risk_profile').$type<RiskProfile>().notNull().default('conservative'),
    policy: jsonb('policy').$type<RiskPolicy>().notNull(),
    /** Minutes between ticks. Bounded by the plan. */
    cadenceMinutes: integer('cadence_minutes').notNull().default(1440),
    nextRunAt: ts('next_run_at'),
    /** A worker holds the agent until this time; nobody else may run it. */
    leaseUntil: ts('lease_until'),
    lastRunAt: ts('last_run_at'),
    /** When the user accepted the risk disclosure, and which version of it. */
    riskAcknowledgedAt: ts('risk_acknowledged_at'),
    riskDisclosureVersion: text('risk_disclosure_version'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agents_user_uq').on(t.userId),
    index('agents_due_idx').on(t.status, t.nextRunAt),
    check('agents_mode_ck', sql`${t.mode} in ('paper','approval','auto')`),
    check('agents_status_ck', sql`${t.status} in ('active','paused','halted')`),
    check('agents_cadence_ck', sql`${t.cadenceMinutes} between 15 and 10080`),
  ],
)

/** One book per agent per ledger. Paper and live never share cash or positions. */
export const ledgers = pgTable(
  'ledgers',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ledger: text('ledger').$type<Ledger>().notNull(),
    cashUsd: money('cash_usd').notNull(),
    realizedPnlUsd: money('realized_pnl_usd').notNull().default('0'),
    peakEquityUsd: money('peak_equity_usd').notNull(),
    dayStartEquityUsd: money('day_start_equity_usd').notNull(),
    /** UTC calendar day the day-start equity belongs to, YYYY-MM-DD. */
    dayStartDate: text('day_start_date').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.ledger] }), check('ledgers_ledger_ck', sql`${t.ledger} in ('paper','live')`), check('ledgers_cash_ck', sql`${t.cashUsd} >= 0`)],
)

export const positions = pgTable(
  'positions',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ledger: text('ledger').$type<Ledger>().notNull(),
    productId: text('product_id').notNull(),
    qty: money('qty').notNull(),
    costUsd: money('cost_usd').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.ledger, t.productId] }), check('positions_qty_ck', sql`${t.qty} >= 0`)],
)

export const orders = pgTable(
  'orders',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ledger: text('ledger').$type<Ledger>().notNull(),
    runId: text('run_id'),
    /** Idempotency key sent to the exchange. Unique, so a retried tick cannot place a second order. */
    clientOrderId: text('client_order_id').notNull(),
    productId: text('product_id').notNull(),
    side: text('side').$type<Side>().notNull(),
    status: text('status').$type<OrderStatus>().notNull(),
    baseSize: money('base_size'),
    limitPrice: money('limit_price'),
    notionalUsd: money('notional_usd').notNull(),
    filledBaseSize: money('filled_base_size').notNull().default('0'),
    filledQuoteUsd: money('filled_quote_usd').notNull().default('0'),
    feeUsd: money('fee_usd').notNull().default('0'),
    avgPrice: money('avg_price'),
    realizedPnlUsd: money('realized_pnl_usd'),
    exchangeOrderId: text('exchange_order_id'),
    /** Why the allocator wanted this trade. Plain text, shown to the user. */
    reason: text('reason').notNull(),
    riskChecks: jsonb('risk_checks').$type<RiskCheck[]>().notNull(),
    error: text('error'),
    /** For orders awaiting approval. */
    expiresAt: ts('expires_at'),
    submittedAt: ts('submitted_at'),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('orders_client_order_uq').on(t.clientOrderId),
    index('orders_agent_created_idx').on(t.agentId, t.createdAt),
    index('orders_user_created_idx').on(t.userId, t.createdAt),
    index('orders_open_idx').on(t.status).where(sql`${t.status} in ('awaiting_approval','submitted')`),
    check('orders_side_ck', sql`${t.side} in ('BUY','SELL')`),
    check('orders_ledger_ck', sql`${t.ledger} in ('paper','live')`),
    check('orders_status_ck', sql`${t.status} in ('awaiting_approval','rejected','expired','submitted','filled','partially_filled','cancelled','failed')`),
  ],
)

export interface AgentRunSummary {
  regime?: Regime
  equityUsd?: string
  targets?: Record<string, number>
  intents?: number
  approved?: number
  rejected?: number
  filled?: number
  note?: string
}

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ledger: text('ledger').$type<Ledger>().notNull(),
    deskRunId: text('desk_run_id'),
    outcome: text('outcome').$type<'ok' | 'no_trades' | 'skipped' | 'halted' | 'error'>().notNull(),
    summary: jsonb('summary').$type<AgentRunSummary>().notNull(),
    error: text('error'),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
  },
  (t) => [index('agent_runs_agent_idx').on(t.agentId, t.startedAt)],
)

export const equitySnapshots = pgTable(
  'equity_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ledger: text('ledger').$type<Ledger>().notNull(),
    at: ts('at').notNull(),
    equityUsd: money('equity_usd').notNull(),
    cashUsd: money('cash_usd').notNull(),
  },
  (t) => [index('equity_snapshots_agent_idx').on(t.agentId, t.ledger, t.at)],
)

/** The shared desk analysis every agent reads. Contains market data and model output only; never anything about a user. */
export const deskRuns = pgTable(
  'desk_runs',
  {
    id: id(),
    source: text('source').$type<'ai+quant' | 'quant'>().notNull(),
    regime: text('regime').$type<Regime>().notNull(),
    report: jsonb('report').notNull(),
    marketAsOf: ts('market_as_of').notNull(),
    models: jsonb('models').$type<{ orchestrator?: string; analyst?: string }>(),
    usage: jsonb('usage').$type<{ inputTokens?: number; outputTokens?: number }>(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('desk_runs_created_idx').on(t.createdAt)],
)

// ---------------------------------------------------------------------------
// Coinbase connection
// ---------------------------------------------------------------------------

export const coinbaseConnections = pgTable(
  'coinbase_connections',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Coinbase's id for the linked user, to detect a different account being linked later. */
    coinbaseUserId: text('coinbase_user_id'),
    /** Space-separated scopes Coinbase actually granted. */
    scopes: text('scopes').notNull(),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    accessExpiresAt: ts('access_expires_at').notNull(),
    status: text('status').$type<'active' | 'needs_reauth'>().notNull().default('active'),
    lastRefreshedAt: ts('last_refreshed_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('coinbase_connections_user_uq').on(t.userId), uniqueIndex('coinbase_connections_account_uq').on(t.coinbaseUserId), check('coinbase_connections_status_ck', sql`${t.status} in ('active','needs_reauth')`)],
)

/** One row per in-flight OAuth authorization. Single use, short lived, bound to the user who started it. */
export const oauthStates = pgTable(
  'oauth_states',
  {
    /** SHA-256 of the state value; the value itself only exists in the redirect. */
    stateHash: text('state_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    codeVerifierEnc: text('code_verifier_enc').notNull(),
    scopes: text('scopes').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('oauth_states_expires_idx').on(t.expiresAt)],
)

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const subscriptions = pgTable(
  'subscriptions',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    plan: text('plan').$type<'free' | 'pilot' | 'desk'>().notNull().default('free'),
    /** The processor's subscription status, or "none". */
    status: text('status').notNull().default('none'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    priceId: text('price_id'),
    currentPeriodEnd: ts('current_period_end'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('subscriptions_customer_uq').on(t.stripeCustomerId), uniqueIndex('subscriptions_subscription_uq').on(t.stripeSubscriptionId), check('subscriptions_plan_ck', sql`${t.plan} in ('free','pilot','desk')`)],
)

/** Processed webhook events. The primary key is what makes a replayed webhook a no-op. */
export const billingEvents = pgTable('billing_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  error: text('error'),
})

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export type AuditActor = 'user' | 'agent' | 'system'

/** Append-only record of everything that matters: sign-ins, links, settings, every decision and order. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    userId: text('user_id'),
    actor: text('actor').$type<AuditActor>().notNull(),
    /** Dotted verb, e.g. "agent.order.filled", "coinbase.linked". */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** One plain sentence a person can read. */
    summary: text('summary').notNull(),
    /** Structured detail. Never contains secrets; see lib/security/audit. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** Keyed hash of the client address, so events can be correlated without storing the address. */
    ipHash: text('ip_hash'),
  },
  (t) => [index('audit_user_at_idx').on(t.userId, t.at), index('audit_action_idx').on(t.action, t.at), check('audit_actor_ck', sql`${t.actor} in ('user','agent','system')`)],
)

/** Fixed-window counters for the app's own rate limits. */
export const appRateLimits = pgTable(
  'app_rate_limits',
  {
    key: text('key').notNull(),
    windowStart: ts('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index('app_rate_limits_window_idx').on(t.windowStart)],
)

/** Operator switches, e.g. `trading_halted`. */
export const platformFlags = pgTable('platform_flags', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
})
