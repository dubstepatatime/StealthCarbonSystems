# Security

Report a vulnerability privately through GitHub's "Report a vulnerability" on this repository. Please do not open a public issue.

## Design

The site is three pages (`/`, `/sign-in`, `/desk`) and five API routes. Less surface, fewer places to be wrong.

| Risk | Control | Where |
| --- | --- | --- |
| The app moves a user's money out | The Coinbase link requests trade and read scopes only; a link granted any other scope is revoked and refused. | `lib/coinbase/oauth.ts`, `app/api/coinbase/callback/route.ts` |
| A bad or manipulated model output places a harmful order | The model never produces an order. It can tilt a signal by at most 0.35; a deterministic risk engine sizes, clamps or rejects every order. | `lib/trading/signals.ts`, `lib/trading/risk.ts` |
| Runaway trading | Per-order, per-position, exposure, daily-turnover and trade-count limits; price collars; cooldowns; daily-loss and drawdown circuit breakers; user pause; operator kill switch (`TRADING_HALTED`). | `lib/trading/risk.ts`, `lib/trading/limits.ts` |
| Trading the wrong thing | Spot products from a four-item allow-list. The authenticated client can call five fixed Coinbase routes and nothing else. | `lib/coinbase/api.ts` |
| Double orders | Each order is stored under a unique client order id before it is sent; the database rejects a duplicate. | `lib/trading/engine.ts`, `lib/db/schema.ts` |
| Stolen database | Coinbase tokens are sealed with AES-256-GCM under a key held outside the database and bound to their owner. Passwords are hashed by Better Auth. | `lib/security/crypto.ts` |
| Account takeover | Rate-limited sign-in, 12-character minimum passwords, TOTP two-factor (required for live trading), HttpOnly Secure SameSite session cookies, a recent sign-in required to go live or link Coinbase. | `lib/auth/server.ts`, `app/desk/actions.ts` |
| One user reaching another's data | Every query filters on the signed-in user's id; every action re-checks the session itself. | `app/desk/actions.ts`, `lib/auth/session.ts` |
| OAuth CSRF / code interception | Random single-use state stored hashed and bound to the user, PKCE S256, fixed redirect URI from `APP_URL`. | `app/desk/actions.ts`, `app/api/coinbase/callback/route.ts` |
| Cross-site scripting | Strict CSP with a per-request nonce, no inline styles or scripts, no third-party origins (fonts are self-hosted), React escaping, fixed message codes instead of echoed input. | `proxy.ts`, `next.config.mjs` |
| Clickjacking, sniffing, downgrade | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, HSTS, same-origin opener and resource policies. | `next.config.mjs` |
| Forged billing events | Stripe signature verified over the raw body; events de-duplicated by id; entitlements come only from webhooks. | `lib/billing/stripe.ts` |
| Forged scheduler calls | `/api/cron/tick` requires `CRON_SECRET`, compared in constant time. | `app/api/cron/tick/route.ts` |
| Server-side request forgery | Outbound market-data hosts are a fixed allow-list; no URL is built from request input. | `lib/markets/http.ts` |
| Tampering with history | `audit_events` is append-only, enforced by database triggers. | `drizzle/0001_audit_append_only.sql` |
| Compromised dependency | pnpm refuses versions newer than seven days and runs no install scripts. | `pnpm-workspace.yaml` |

## Known gaps

- Email verification and password reset are not wired up (no mail provider is configured).
- Live orders that the exchange has accepted but not yet reported as filled are left as `submitted`; there is no background reconciliation yet.
- The Coinbase live path and Stripe path are covered by unit tests but have not been exercised against the real services.
- No independent penetration test has been done.
