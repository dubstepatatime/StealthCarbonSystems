# Agentic Trading Desk

Live cross-market data (US, global, crypto, gold and silver) and an AI trading agent that rebalances a user's Coinbase account inside limits they set. Built on IBM Carbon, dark theme only.

Three pages: `/` (markets, safeguards, plans), `/sign-in`, `/desk`. See [SECURITY.md](SECURITY.md) for the threat-by-threat design.

## Run it

```bash
pnpm install
```

```bash
pnpm dev
```

No configuration is needed in development: it uses an embedded Postgres (`.data/`), paper trading, and rules-only signals.

```bash
pnpm check
```

runs the type check and the test suite.

## How a trade happens

1. **Market data** — Coinbase (crypto, PAX Gold; real time) and Yahoo Finance (indices, metals futures; may be delayed). If Yahoo fails, gold and silver fall back to Coinbase Derivatives futures. `lib/markets`
2. **Desk** — a rules-based trend and momentum score per asset. If `AI_GATEWAY_API_KEY` is set, a model may tilt each score by a bounded amount and writes the narrative. `lib/trading/desk.ts`
3. **Allocator** — long-only target weights; cash by default. `lib/trading/allocator.ts`
4. **Risk engine** — approves, shrinks or rejects each order. `lib/trading/risk.ts`
5. **Broker** — paper (simulated fills on real quotes) or Coinbase (limit immediate-or-cancel). `lib/trading/engine.ts`

The agent keeps its own book, so it never spends more than the capital it was given and never sells an asset it did not buy.

## Deploy

Set the variables in `.env.example`, run `pnpm db:migrate` against the database, deploy. `vercel.json` schedules the agent hourly.

Before taking real customers:

- **Coinbase approval.** Coinbase currently limits OAuth client creation to approved partners. Live trading for other people's accounts cannot start until Coinbase approves the app.
- **Licensed market data.** The Yahoo endpoint is unofficial and has no terms for commercial use. Replace it with a licensed feed.
- **Legal review.** Running trades in customers' accounts for a fee raises adviser, commodity and state licensing questions. Take them to a lawyer before launch.
