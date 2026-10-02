CREATE TABLE "price_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"price_before_minor" integer NOT NULL,
	"price_after_minor" integer NOT NULL,
	"compare_at_before_minor" integer,
	"compare_at_after_minor" integer,
	"source" text NOT NULL,
	"batch_id" uuid,
	"actor_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_take_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_take_id" uuid NOT NULL,
	"variant_id" uuid,
	"code" text NOT NULL,
	"counted" integer DEFAULT 0 NOT NULL,
	"expected_at_apply" integer,
	"applied_delta" integer,
	"counted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_take_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_takes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"created_by" uuid,
	"applied_by" uuid,
	"applied_at" timestamp with time zone,
	"applied_movements" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_takes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "reason_code" text;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_take_counts" ADD CONSTRAINT "stock_take_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_take_counts" ADD CONSTRAINT "stock_take_counts_stock_take_id_stock_takes_id_fk" FOREIGN KEY ("stock_take_id") REFERENCES "public"."stock_takes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_take_counts" ADD CONSTRAINT "stock_take_counts_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_take_counts" ADD CONSTRAINT "stock_take_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_changes_variant_idx" ON "price_changes" USING btree ("tenant_id","variant_id","created_at");--> statement-breakpoint
CREATE INDEX "price_changes_tenant_source_idx" ON "price_changes" USING btree ("tenant_id","source","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_take_counts_variant_uq" ON "stock_take_counts" USING btree ("stock_take_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_take_counts_take_idx" ON "stock_take_counts" USING btree ("tenant_id","stock_take_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_takes_tenant_number_uq" ON "stock_takes" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "stock_takes_tenant_status_idx" ON "stock_takes" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE POLICY "price_changes_tenant_isolation" ON "price_changes" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_take_counts_tenant_isolation" ON "stock_take_counts" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_takes_tenant_isolation" ON "stock_takes" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);