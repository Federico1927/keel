CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text NOT NULL,
	"name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"mode" text DEFAULT 'mock' NOT NULL,
	"credentials_encrypted" text,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_attribution" ADD COLUMN "ad_account_external_id" text;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "account_external_id" text;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD COLUMN "account_external_id" text;--> statement-breakpoint
ALTER TABLE "ad_sets" ADD COLUMN "account_external_id" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "kind" text DEFAULT 'purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "value_minor" integer;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_uq" ON "ad_accounts" USING btree ("tenant_id","provider","external_account_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_tenant_idx" ON "ad_accounts" USING btree ("tenant_id","provider","status");--> statement-breakpoint
CREATE INDEX "campaigns_tenant_account_idx" ON "campaigns" USING btree ("tenant_id","platform","account_external_id");--> statement-breakpoint
CREATE INDEX "conversion_events_order_idx" ON "conversion_events" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE POLICY "ad_accounts_tenant_isolation" ON "ad_accounts" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);