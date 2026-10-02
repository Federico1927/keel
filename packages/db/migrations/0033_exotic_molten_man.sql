CREATE TABLE "tenant_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"plan_key" text NOT NULL,
	"addons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monthly_minor" integer DEFAULT 0 NOT NULL,
	"actor_user_id" uuid,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_lifecycle_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_by" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "churned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status_note" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_lifecycle_events" ADD CONSTRAINT "tenant_lifecycle_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_lifecycle_events_tenant_idx" ON "tenant_lifecycle_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "tenant_lifecycle_events_created_idx" ON "tenant_lifecycle_events" USING btree ("created_at");--> statement-breakpoint
CREATE POLICY "tenant_lifecycle_events_tenant_isolation" ON "tenant_lifecycle_events" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);