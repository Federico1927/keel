CREATE TABLE "balance_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text DEFAULT 'shopify' NOT NULL,
	"external_id" text NOT NULL,
	"payout_id" uuid,
	"payout_external_id" text,
	"type" text NOT NULL,
	"order_id" uuid,
	"order_external_id" text,
	"amount_minor" integer NOT NULL,
	"fee_minor" integer DEFAULT 0 NOT NULL,
	"net_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "balance_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"method" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"note" text,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restock_location_id" uuid,
	"external_id" text,
	"requested_minor" integer,
	"written_to_platform" boolean DEFAULT false NOT NULL,
	"actor_user_id" uuid,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text DEFAULT 'shopify' NOT NULL,
	"external_id" text NOT NULL,
	"status" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"gross_minor" integer DEFAULT 0 NOT NULL,
	"refunds_minor" integer DEFAULT 0 NOT NULL,
	"adjustments_minor" integer DEFAULT 0 NOT NULL,
	"fee_minor" integer DEFAULT 0 NOT NULL,
	"net_minor" integer DEFAULT 0 NOT NULL,
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_transactions" ADD CONSTRAINT "order_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_transactions" ADD CONSTRAINT "order_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_transactions" ADD CONSTRAINT "order_transactions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "balance_transactions_tenant_provider_external_uq" ON "balance_transactions" USING btree ("tenant_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "balance_transactions_order_idx" ON "balance_transactions" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "balance_transactions_payout_idx" ON "balance_transactions" USING btree ("tenant_id","payout_id");--> statement-breakpoint
CREATE INDEX "balance_transactions_order_external_idx" ON "balance_transactions" USING btree ("tenant_id","order_external_id");--> statement-breakpoint
CREATE INDEX "order_transactions_order_idx" ON "order_transactions" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "order_transactions_occurred_idx" ON "order_transactions" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_tenant_provider_external_uq" ON "payouts" USING btree ("tenant_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "payouts_tenant_issued_idx" ON "payouts" USING btree ("tenant_id","issued_at");--> statement-breakpoint
CREATE POLICY "balance_transactions_tenant_isolation" ON "balance_transactions" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_transactions_tenant_isolation" ON "order_transactions" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payouts_tenant_isolation" ON "payouts" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);