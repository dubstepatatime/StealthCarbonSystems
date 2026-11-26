CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"ledger" text NOT NULL,
	"desk_run_id" text,
	"outcome" text NOT NULL,
	"summary" jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mode" text DEFAULT 'paper' NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"halt_reason" text,
	"risk_profile" text DEFAULT 'conservative' NOT NULL,
	"policy" jsonb NOT NULL,
	"cadence_minutes" integer DEFAULT 1440 NOT NULL,
	"next_run_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"risk_acknowledged_at" timestamp with time zone,
	"risk_disclosure_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_mode_ck" CHECK ("agents"."mode" in ('paper','approval','auto')),
	CONSTRAINT "agents_status_ck" CHECK ("agents"."status" in ('active','paused','halted')),
	CONSTRAINT "agents_cadence_ck" CHECK ("agents"."cadence_minutes" between 15 and 10080)
);
--> statement-breakpoint
CREATE TABLE "app_rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "app_rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"summary" text NOT NULL,
	"metadata" jsonb,
	"ip_hash" text,
	CONSTRAINT "audit_actor_ck" CHECK ("audit_events"."actor" in ('user','agent','system'))
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "coinbase_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"coinbase_user_id" text,
	"scopes" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"access_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coinbase_connections_status_ck" CHECK ("coinbase_connections"."status" in ('active','needs_reauth'))
);
--> statement-breakpoint
CREATE TABLE "desk_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"regime" text NOT NULL,
	"report" jsonb NOT NULL,
	"market_as_of" timestamp with time zone NOT NULL,
	"models" jsonb,
	"usage" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equity_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"ledger" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"equity_usd" numeric(38, 18) NOT NULL,
	"cash_usd" numeric(38, 18) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledgers" (
	"agent_id" text NOT NULL,
	"ledger" text NOT NULL,
	"cash_usd" numeric(38, 18) NOT NULL,
	"realized_pnl_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"peak_equity_usd" numeric(38, 18) NOT NULL,
	"day_start_equity_usd" numeric(38, 18) NOT NULL,
	"day_start_date" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledgers_agent_id_ledger_pk" PRIMARY KEY("agent_id","ledger"),
	CONSTRAINT "ledgers_ledger_ck" CHECK ("ledgers"."ledger" in ('paper','live')),
	CONSTRAINT "ledgers_cash_ck" CHECK ("ledgers"."cash_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_verifier_enc" text NOT NULL,
	"scopes" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"ledger" text NOT NULL,
	"run_id" text,
	"client_order_id" text NOT NULL,
	"product_id" text NOT NULL,
	"side" text NOT NULL,
	"status" text NOT NULL,
	"base_size" numeric(38, 18),
	"limit_price" numeric(38, 18),
	"notional_usd" numeric(38, 18) NOT NULL,
	"filled_base_size" numeric(38, 18) DEFAULT '0' NOT NULL,
	"filled_quote_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"fee_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"avg_price" numeric(38, 18),
	"realized_pnl_usd" numeric(38, 18),
	"exchange_order_id" text,
	"reason" text NOT NULL,
	"risk_checks" jsonb NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_side_ck" CHECK ("orders"."side" in ('BUY','SELL')),
	CONSTRAINT "orders_ledger_ck" CHECK ("orders"."ledger" in ('paper','live')),
	CONSTRAINT "orders_status_ck" CHECK ("orders"."status" in ('awaiting_approval','rejected','expired','submitted','filled','partially_filled','cancelled','failed'))
);
--> statement-breakpoint
CREATE TABLE "platform_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"agent_id" text NOT NULL,
	"ledger" text NOT NULL,
	"product_id" text NOT NULL,
	"qty" numeric(38, 18) NOT NULL,
	"cost_usd" numeric(38, 18) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_agent_id_ledger_product_id_pk" PRIMARY KEY("agent_id","ledger","product_id"),
	CONSTRAINT "positions_qty_ck" CHECK ("positions"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"price_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_plan_ck" CHECK ("subscriptions"."plan" in ('free','pilot','desk'))
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coinbase_connections" ADD CONSTRAINT "coinbase_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_idx" ON "agent_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_user_uq" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agents_due_idx" ON "agents" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "app_rate_limits_window_idx" ON "app_rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "audit_user_at_idx" ON "audit_events" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_events" USING btree ("action","at");--> statement-breakpoint
CREATE UNIQUE INDEX "coinbase_connections_user_uq" ON "coinbase_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "desk_runs_created_idx" ON "desk_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "equity_snapshots_agent_idx" ON "equity_snapshots" USING btree ("agent_id","ledger","at");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_client_order_uq" ON "orders" USING btree ("client_order_id");--> statement-breakpoint
CREATE INDEX "orders_agent_created_idx" ON "orders" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_open_idx" ON "orders" USING btree ("status") WHERE "orders"."status" in ('awaiting_approval','submitted');--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_customer_uq" ON "subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_subscription_uq" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "two_factor_user_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");