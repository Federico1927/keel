CREATE TABLE "analytics_traffic_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text DEFAULT 'ga4' NOT NULL,
	"property_id" text NOT NULL,
	"date" date NOT NULL,
	"channel_group" text NOT NULL,
	"channel" text DEFAULT 'unknown' NOT NULL,
	"source" text NOT NULL,
	"medium" text NOT NULL,
	"campaign_name" text NOT NULL,
	"landing_path" text NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"total_users" integer DEFAULT 0 NOT NULL,
	"engaged_sessions" integer DEFAULT 0 NOT NULL,
	"add_to_carts" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_traffic_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_traffic_daily" ADD CONSTRAINT "analytics_traffic_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_traffic_daily_uq" ON "analytics_traffic_daily" USING btree ("tenant_id","provider","property_id","date","channel_group","source","medium","campaign_name","landing_path");--> statement-breakpoint
CREATE INDEX "analytics_traffic_daily_date_idx" ON "analytics_traffic_daily" USING btree ("tenant_id","provider","property_id","date");--> statement-breakpoint
CREATE INDEX "analytics_traffic_daily_channel_idx" ON "analytics_traffic_daily" USING btree ("tenant_id","channel","date");--> statement-breakpoint
CREATE POLICY "analytics_traffic_daily_tenant_isolation" ON "analytics_traffic_daily" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);