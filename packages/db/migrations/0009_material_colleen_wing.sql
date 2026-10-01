CREATE TABLE "public_rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public_rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "return_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_id" uuid,
	"session_nonce" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "return_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "return_portal_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "return_portal_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "return_lines" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "return_lines" ADD COLUMN "platform_restocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "return_reasons" ADD COLUMN "labels" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "return_reasons" ADD COLUMN "platform_reason" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "source" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "deduction_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "tracking_code" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "tracking_carrier" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "exchange_note" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "bank_details_enc" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "customer_locale" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "platform_sync_status" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "platform_status" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "platform_error" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "platform_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "platform_refund_id" text;--> statement-breakpoint
ALTER TABLE "public_rate_limits" ADD CONSTRAINT "public_rate_limits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_evidence" ADD CONSTRAINT "return_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_evidence" ADD CONSTRAINT "return_evidence_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_portal_settings" ADD CONSTRAINT "return_portal_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_portal_settings" ADD CONSTRAINT "return_portal_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "public_rate_limits_uq" ON "public_rate_limits" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "return_evidence_return_idx" ON "return_evidence" USING btree ("tenant_id","return_id");--> statement-breakpoint
CREATE INDEX "return_evidence_session_idx" ON "return_evidence" USING btree ("tenant_id","session_nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "return_portal_settings_tenant_uq" ON "return_portal_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_requests_idempotency_uq" ON "return_requests" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "return_requests_sync_idx" ON "return_requests" USING btree ("tenant_id","platform_sync_status");--> statement-breakpoint
CREATE POLICY "public_rate_limits_tenant_isolation" ON "public_rate_limits" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "return_evidence_tenant_isolation" ON "return_evidence" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "return_portal_settings_tenant_isolation" ON "return_portal_settings" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);