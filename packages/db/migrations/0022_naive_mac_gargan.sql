CREATE TABLE "platform_writes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"mode" text DEFAULT 'async' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"target_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_error_code" text,
	"result" jsonb,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_user_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_writes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory_drift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"run_id" uuid,
	"local_before" integer NOT NULL,
	"expected" integer NOT NULL,
	"observed" integer NOT NULL,
	"delta" integer NOT NULL,
	"applied" integer NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_drift" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "rows_scanned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "conflicts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "error_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "summary" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_writes" ADD CONSTRAINT "platform_writes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_drift" ADD CONSTRAINT "inventory_drift_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_drift" ADD CONSTRAINT "inventory_drift_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_drift" ADD CONSTRAINT "inventory_drift_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_writes_idempotency_uq" ON "platform_writes" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "platform_writes_due_idx" ON "platform_writes" USING btree ("tenant_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "platform_writes_entity_idx" ON "platform_writes" USING btree ("tenant_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_writes_target_idx" ON "platform_writes" USING btree ("tenant_id","target_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_drift_dedupe_uq" ON "inventory_drift" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "inventory_drift_tenant_seen_idx" ON "inventory_drift" USING btree ("tenant_id","last_seen_at");--> statement-breakpoint
CREATE POLICY "platform_writes_tenant_isolation" ON "platform_writes" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_drift_tenant_isolation" ON "inventory_drift" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);