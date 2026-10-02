CREATE TABLE "segment_destination_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "segment_destination_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "segment_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"audience_name" text NOT NULL,
	"external_audience_id" text,
	"auto_sync" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'never' NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_added" integer DEFAULT 0 NOT NULL,
	"last_removed" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "segment_destinations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "live_updates" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "segment_destination_members" ADD CONSTRAINT "segment_destination_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_destination_members" ADD CONSTRAINT "segment_destination_members_destination_id_segment_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."segment_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_destination_members" ADD CONSTRAINT "segment_destination_members_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_destinations" ADD CONSTRAINT "segment_destinations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_destinations" ADD CONSTRAINT "segment_destinations_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_destinations" ADD CONSTRAINT "segment_destinations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "segment_destination_members_uq" ON "segment_destination_members" USING btree ("destination_id","customer_id");--> statement-breakpoint
CREATE INDEX "segment_destinations_segment_idx" ON "segment_destinations" USING btree ("tenant_id","segment_id");--> statement-breakpoint
CREATE POLICY "segment_destination_members_tenant_isolation" ON "segment_destination_members" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "segment_destinations_tenant_isolation" ON "segment_destinations" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);