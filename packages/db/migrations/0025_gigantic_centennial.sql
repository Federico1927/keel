CREATE TABLE "list_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"list" text NOT NULL,
	"query" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"row_count" integer,
	"file_name" text,
	"content" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "list_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"name" text NOT NULL,
	"query" text DEFAULT '' NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "list_exports" ADD CONSTRAINT "list_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_exports" ADD CONSTRAINT "list_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "list_exports_user_idx" ON "list_exports" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "saved_views_page_idx" ON "saved_views" USING btree ("tenant_id","page_key");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_owner_name_uq" ON "saved_views" USING btree ("tenant_id","page_key","owner_user_id","name");--> statement-breakpoint
CREATE INDEX "product_variants_sku_trgm_idx" ON "product_variants" USING gin (lower("sku") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_title_trgm_idx" ON "products" USING gin (lower("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_search_trgm_idx" ON "customers" USING gin ((lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email, ''))) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "order_lines_product_idx" ON "order_lines" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE POLICY "list_exports_tenant_isolation" ON "list_exports" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "saved_views_tenant_isolation" ON "saved_views" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);