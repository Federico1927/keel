CREATE TABLE "bundle_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_variant_id" uuid NOT NULL,
	"component_variant_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"kind" text DEFAULT 'bundle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bundle_components" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "demand_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"month" text NOT NULL,
	"uplift_bps" integer NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"scope_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demand_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forecast_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"month" text NOT NULL,
	"units" integer NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forecast_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_order_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"basis" text DEFAULT 'value' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_order_charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "supplier_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"supplier_sku" text,
	"unit_cost_minor" integer,
	"moq" integer,
	"order_multiple" integer,
	"lead_time_days" integer,
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "landed_unit_cost_minor" integer;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_token" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_ack_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_ack_note" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "sent_to_email" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "lead_time_sd_days" integer;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "deposit_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "balance_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "moq_default" integer;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "order_multiple_default" integer;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "bundle_components" ADD CONSTRAINT "bundle_components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_components" ADD CONSTRAINT "bundle_components_parent_variant_id_product_variants_id_fk" FOREIGN KEY ("parent_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_components" ADD CONSTRAINT "bundle_components_component_variant_id_product_variants_id_fk" FOREIGN KEY ("component_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_events" ADD CONSTRAINT "demand_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_overrides" ADD CONSTRAINT "forecast_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_overrides" ADD CONSTRAINT "forecast_overrides_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_overrides" ADD CONSTRAINT "forecast_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_charges" ADD CONSTRAINT "purchase_order_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_charges" ADD CONSTRAINT "purchase_order_charges_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_variants" ADD CONSTRAINT "supplier_variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_variants" ADD CONSTRAINT "supplier_variants_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_variants" ADD CONSTRAINT "supplier_variants_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bundle_components_uq" ON "bundle_components" USING btree ("tenant_id","parent_variant_id","component_variant_id");--> statement-breakpoint
CREATE INDEX "bundle_components_component_idx" ON "bundle_components" USING btree ("tenant_id","component_variant_id");--> statement-breakpoint
CREATE INDEX "demand_events_tenant_month_idx" ON "demand_events" USING btree ("tenant_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_overrides_uq" ON "forecast_overrides" USING btree ("tenant_id","variant_id","month");--> statement-breakpoint
CREATE INDEX "purchase_order_charges_po_idx" ON "purchase_order_charges" USING btree ("tenant_id","purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_variants_uq" ON "supplier_variants" USING btree ("tenant_id","supplier_id","variant_id");--> statement-breakpoint
CREATE INDEX "supplier_variants_variant_idx" ON "supplier_variants" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_supplier_token_uq" ON "purchase_orders" USING btree ("supplier_token");--> statement-breakpoint
CREATE POLICY "bundle_components_tenant_isolation" ON "bundle_components" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demand_events_tenant_isolation" ON "demand_events" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "forecast_overrides_tenant_isolation" ON "forecast_overrides" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "purchase_order_charges_tenant_isolation" ON "purchase_order_charges" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "supplier_variants_tenant_isolation" ON "supplier_variants" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);