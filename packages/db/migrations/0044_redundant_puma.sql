CREATE TABLE "spoki_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"purpose" text NOT NULL,
	"provider_message_id" text,
	"idempotency_key" text,
	"phone" text NOT NULL,
	"customer_id" uuid,
	"order_id" uuid,
	"campaign_id" uuid,
	"template_id" text,
	"template_name" text,
	"body" text,
	"status" text NOT NULL,
	"status_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"reply_to_message_id" text,
	"sent_by" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spoki_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spoki_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"templates_synced_at" timestamp with time zone,
	"notified_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spoki_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "spoki_messages" ADD CONSTRAINT "spoki_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spoki_messages" ADD CONSTRAINT "spoki_messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spoki_messages" ADD CONSTRAINT "spoki_messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spoki_messages" ADD CONSTRAINT "spoki_messages_campaign_id_retention_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."retention_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spoki_messages" ADD CONSTRAINT "spoki_messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spoki_settings" ADD CONSTRAINT "spoki_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spoki_messages_provider_uq" ON "spoki_messages" USING btree ("tenant_id","provider_message_id") WHERE "spoki_messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "spoki_messages_key_uq" ON "spoki_messages" USING btree ("tenant_id","idempotency_key") WHERE "spoki_messages"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "spoki_messages_order_idx" ON "spoki_messages" USING btree ("tenant_id","order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "spoki_messages_customer_idx" ON "spoki_messages" USING btree ("tenant_id","customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "spoki_messages_phone_idx" ON "spoki_messages" USING btree ("tenant_id","phone","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spoki_settings_tenant_uq" ON "spoki_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "spoki_messages_tenant_isolation" ON "spoki_messages" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "spoki_settings_tenant_isolation" ON "spoki_settings" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);