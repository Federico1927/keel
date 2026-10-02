CREATE TABLE "metric_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"month" text NOT NULL,
	"target" double precision NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metric_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dashboards" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_metrics" ADD COLUMN "filters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_metrics" ADD COLUMN "higher_is_better" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_metrics" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "scope" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "is_home" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "layout_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "draft_widgets" jsonb;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_targets_uq" ON "metric_targets" USING btree ("tenant_id","metric","month");--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboards_scope_idx" ON "dashboards" USING btree ("tenant_id","scope","is_home");--> statement-breakpoint
CREATE POLICY "metric_targets_tenant_isolation" ON "metric_targets" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);