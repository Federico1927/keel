CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"queue" text NOT NULL,
	"job_type" text NOT NULL,
	"trigger" text DEFAULT 'queue' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"rows" integer,
	"error" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" uuid
);
--> statement-breakpoint
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"signature" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone,
	"notified_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" uuid,
	"requested_by_type" text DEFAULT 'owner' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer,
	"file_name" text,
	"file" "bytea",
	"size_bytes" integer,
	"error" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone,
	"download_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_data_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_health" ADD COLUMN "zero_row_runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_health" ADD COLUMN "watchdog_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_health" ADD COLUMN "resync_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_alerts" ADD CONSTRAINT "platform_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_data_exports" ADD CONSTRAINT "tenant_data_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_data_exports" ADD CONSTRAINT "tenant_data_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_runs_type_started_idx" ON "job_runs" USING btree ("job_type","started_at");--> statement-breakpoint
CREATE INDEX "job_runs_tenant_started_idx" ON "job_runs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "job_runs_started_idx" ON "job_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_alerts_signature_uq" ON "platform_alerts" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "platform_alerts_status_seen_idx" ON "platform_alerts" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "platform_alerts_tenant_idx" ON "platform_alerts" USING btree ("tenant_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "tenant_data_exports_tenant_created_idx" ON "tenant_data_exports" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE POLICY "job_runs_tenant_select" ON "job_runs" AS PERMISSIVE FOR SELECT TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "job_runs_tenant_insert" ON "job_runs" AS PERMISSIVE FOR INSERT TO "keel_app" WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "platform_alerts_tenant_select" ON "platform_alerts" AS PERMISSIVE FOR SELECT TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "platform_alerts_tenant_insert" ON "platform_alerts" AS PERMISSIVE FOR INSERT TO "keel_app" WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_data_exports_tenant_isolation" ON "tenant_data_exports" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);