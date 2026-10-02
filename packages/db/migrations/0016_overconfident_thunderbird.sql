CREATE TABLE "conversion_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"payload" jsonb,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversion_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversion_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"destination_id" text,
	"test_event_code" text,
	"require_consent" boolean DEFAULT true NOT NULL,
	"lookback_days" integer DEFAULT 7 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversion_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pixel_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"anonymous_id" text NOT NULL,
	"session_id" text NOT NULL,
	"event" text NOT NULL,
	"url" text,
	"referrer" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"client_ip" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pixel_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pixel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"anonymous_id" text NOT NULL,
	"order_external_id" text,
	"checkout_token" text,
	"email_sha256" text,
	"customer_id" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pixel_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pixel_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"lookback_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pixel_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_settings" ADD CONSTRAINT "conversion_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pixel_events" ADD CONSTRAINT "pixel_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pixel_identities" ADD CONSTRAINT "pixel_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pixel_identities" ADD CONSTRAINT "pixel_identities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pixel_settings" ADD CONSTRAINT "pixel_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_events_uq" ON "conversion_events" USING btree ("tenant_id","provider","event_id");--> statement-breakpoint
CREATE INDEX "conversion_events_due_idx" ON "conversion_events" USING btree ("tenant_id","status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_settings_uq" ON "conversion_settings" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "pixel_events_anon_idx" ON "pixel_events" USING btree ("tenant_id","anonymous_id","occurred_at");--> statement-breakpoint
CREATE INDEX "pixel_events_time_idx" ON "pixel_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "pixel_identities_anon_idx" ON "pixel_identities" USING btree ("tenant_id","anonymous_id");--> statement-breakpoint
CREATE INDEX "pixel_identities_order_idx" ON "pixel_identities" USING btree ("tenant_id","order_external_id");--> statement-breakpoint
CREATE INDEX "pixel_identities_email_idx" ON "pixel_identities" USING btree ("tenant_id","email_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "pixel_settings_tenant_uq" ON "pixel_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pixel_settings_key_uq" ON "pixel_settings" USING btree ("public_key");--> statement-breakpoint
CREATE POLICY "conversion_events_tenant_isolation" ON "conversion_events" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "conversion_settings_tenant_isolation" ON "conversion_settings" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pixel_events_tenant_isolation" ON "pixel_events" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pixel_identities_tenant_isolation" ON "pixel_identities" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pixel_settings_tenant_isolation" ON "pixel_settings" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);