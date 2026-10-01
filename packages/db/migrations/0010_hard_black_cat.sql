CREATE TABLE "return_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "return_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "risk_level" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "risk_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "automations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "returnless" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "return_policies" ADD CONSTRAINT "return_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_policies" ADD CONSTRAINT "return_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "return_policies_tenant_uq" ON "return_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "return_policies_tenant_isolation" ON "return_policies" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);