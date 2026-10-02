CREATE TABLE "subscription_billing_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"amount_minor" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"order_id" uuid,
	"order_external_id" text,
	"attempted_at" timestamp with time zone NOT NULL,
	"next_retry_at" timestamp with time zone,
	"cycle_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_billing_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_cancellation_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" text DEFAULT 'voluntary' NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_cancellation_reasons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_contract_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"variant_external_id" text,
	"sku" text,
	"title" text NOT NULL,
	"variant_title" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_minor" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_contract_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"customer_id" uuid,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"price_minor" integer DEFAULT 0 NOT NULL,
	"mrr_minor" integer DEFAULT 0 NOT NULL,
	"interval_unit" text DEFAULT 'month' NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"next_billing_at" timestamp with time zone,
	"activated_at" timestamp with time zone NOT NULL,
	"paused_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"cancellation_kind" text,
	"cancellation_reason_code" text,
	"cancellation_reason_raw" text,
	"discounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin_order_id" uuid,
	"origin_order_external_id" text,
	"renewals_count" integer DEFAULT 0 NOT NULL,
	"skips_count" integer DEFAULT 0 NOT NULL,
	"payment_failing_since" timestamp with time zone,
	"assigned_to" uuid,
	"last_contact_at" timestamp with time zone,
	"churn_risk" text,
	"churn_retention_bps" integer,
	"churn_factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"churn_computed_at" timestamp with time zone,
	"platform_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_contracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"type" text NOT NULL,
	"author_type" text DEFAULT 'system' NOT NULL,
	"actor_user_id" uuid,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subscription_contract_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_first_subscription_order" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "renewal_number" integer;--> statement-breakpoint
ALTER TABLE "subscription_billing_attempts" ADD CONSTRAINT "subscription_billing_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_billing_attempts" ADD CONSTRAINT "subscription_billing_attempts_contract_id_subscription_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."subscription_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_billing_attempts" ADD CONSTRAINT "subscription_billing_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_cancellation_reasons" ADD CONSTRAINT "subscription_cancellation_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_contract_lines" ADD CONSTRAINT "subscription_contract_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_contract_lines" ADD CONSTRAINT "subscription_contract_lines_contract_id_subscription_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."subscription_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_contract_lines" ADD CONSTRAINT "subscription_contract_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_contract_lines" ADD CONSTRAINT "subscription_contract_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_contracts" ADD CONSTRAINT "subscription_contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_contracts" ADD CONSTRAINT "subscription_contracts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_contracts" ADD CONSTRAINT "subscription_contracts_origin_order_id_orders_id_fk" FOREIGN KEY ("origin_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_contracts" ADD CONSTRAINT "subscription_contracts_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_contract_id_subscription_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."subscription_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_billing_attempts_uq" ON "subscription_billing_attempts" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "subscription_billing_attempts_contract_idx" ON "subscription_billing_attempts" USING btree ("contract_id","attempted_at");--> statement-breakpoint
CREATE INDEX "subscription_billing_attempts_status_idx" ON "subscription_billing_attempts" USING btree ("tenant_id","status","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_cancellation_reasons_uq" ON "subscription_cancellation_reasons" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_contract_lines_uq" ON "subscription_contract_lines" USING btree ("tenant_id","contract_id","external_id");--> statement-breakpoint
CREATE INDEX "subscription_contract_lines_variant_idx" ON "subscription_contract_lines" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_contracts_external_uq" ON "subscription_contracts" USING btree ("tenant_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "subscription_contracts_status_idx" ON "subscription_contracts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "subscription_contracts_customer_idx" ON "subscription_contracts" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "subscription_contracts_next_idx" ON "subscription_contracts" USING btree ("tenant_id","next_billing_at");--> statement-breakpoint
CREATE INDEX "subscription_events_contract_idx" ON "subscription_events" USING btree ("contract_id","occurred_at");--> statement-breakpoint
CREATE INDEX "subscription_events_type_idx" ON "subscription_events" USING btree ("tenant_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "orders_tenant_subscription_idx" ON "orders" USING btree ("tenant_id","subscription_contract_id");--> statement-breakpoint
CREATE POLICY "subscription_billing_attempts_tenant_isolation" ON "subscription_billing_attempts" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscription_cancellation_reasons_tenant_isolation" ON "subscription_cancellation_reasons" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscription_contract_lines_tenant_isolation" ON "subscription_contract_lines" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscription_contracts_tenant_isolation" ON "subscription_contracts" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscription_events_tenant_isolation" ON "subscription_events" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);