CREATE TABLE "period_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"kind" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"estimate_minor" integer DEFAULT 0 NOT NULL,
	"actual_minor" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "period_costs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "period_costs" ADD CONSTRAINT "period_costs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "period_costs_uq" ON "period_costs" USING btree ("tenant_id","period","kind","label");--> statement-breakpoint
CREATE INDEX "period_costs_tenant_period_idx" ON "period_costs" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE POLICY "period_costs_tenant_isolation" ON "period_costs" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);