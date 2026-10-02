CREATE TABLE "retention_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"segment_id" uuid,
	"channel" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"discount_code" text,
	"cost_per_message_minor" integer DEFAULT 0 NOT NULL,
	"attribution_days" integer DEFAULT 14 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"treated_count" integer DEFAULT 0 NOT NULL,
	"holdout_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retention_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retention_exposures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"group_name" text NOT NULL,
	"status" text NOT NULL,
	"message_id" text,
	"error" text,
	"exposed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retention_exposures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD CONSTRAINT "retention_campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD CONSTRAINT "retention_campaigns_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD CONSTRAINT "retention_campaigns_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD CONSTRAINT "retention_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_exposures" ADD CONSTRAINT "retention_exposures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_exposures" ADD CONSTRAINT "retention_exposures_campaign_id_retention_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."retention_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_exposures" ADD CONSTRAINT "retention_exposures_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retention_campaigns_tenant_idx" ON "retention_campaigns" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_exposures_uq" ON "retention_exposures" USING btree ("campaign_id","customer_id");--> statement-breakpoint
CREATE INDEX "retention_exposures_customer_idx" ON "retention_exposures" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE POLICY "retention_campaigns_tenant_isolation" ON "retention_campaigns" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "retention_exposures_tenant_isolation" ON "retention_exposures" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);