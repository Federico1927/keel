CREATE TABLE "accounting_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"provider" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"journal" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"debit_minor" integer DEFAULT 0 NOT NULL,
	"credit_minor" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload_hash" text,
	"external_id" text,
	"external_status" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"last_error_code" text,
	"pushed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"requested_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_journals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounting_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accounts_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounting_journals" ADD CONSTRAINT "accounting_journals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_journals" ADD CONSTRAINT "accounting_journals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_settings" ADD CONSTRAINT "accounting_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_journals_day_version_uq" ON "accounting_journals" USING btree ("tenant_id","day","version");--> statement-breakpoint
CREATE INDEX "accounting_journals_status_idx" ON "accounting_journals" USING btree ("tenant_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "accounting_journals_day_idx" ON "accounting_journals" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_settings_tenant_uq" ON "accounting_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "accounting_journals_tenant_isolation" ON "accounting_journals" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "accounting_settings_tenant_isolation" ON "accounting_settings" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);