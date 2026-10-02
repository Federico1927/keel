CREATE TABLE "cod_carrier_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid,
	"reference" text NOT NULL,
	"outcome" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"cost_minor" integer,
	"import_batch" text NOT NULL,
	"imported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cod_carrier_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cod_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"queue_item_id" uuid,
	"template_key" text NOT NULL,
	"provider" text NOT NULL,
	"recipient" text NOT NULL,
	"body" text NOT NULL,
	"provider_message_id" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"status_at" timestamp with time zone,
	"sent_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cod_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD COLUMN "scheduled_confirm_on" text;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD COLUMN "scheduled_confirm_tried_on" text;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD COLUMN "scheduled_confirm_error" text;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD COLUMN "escalated_by" uuid;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
ALTER TABLE "cod_carrier_outcomes" ADD CONSTRAINT "cod_carrier_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_carrier_outcomes" ADD CONSTRAINT "cod_carrier_outcomes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_carrier_outcomes" ADD CONSTRAINT "cod_carrier_outcomes_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_messages" ADD CONSTRAINT "cod_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_messages" ADD CONSTRAINT "cod_messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_messages" ADD CONSTRAINT "cod_messages_queue_item_id_cod_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."cod_queue_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_messages" ADD CONSTRAINT "cod_messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cod_carrier_outcomes_ref_uq" ON "cod_carrier_outcomes" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "cod_carrier_outcomes_order_idx" ON "cod_carrier_outcomes" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "cod_messages_order_idx" ON "cod_messages" USING btree ("tenant_id","order_id","created_at");--> statement-breakpoint
CREATE INDEX "cod_messages_provider_idx" ON "cod_messages" USING btree ("tenant_id","provider_message_id");--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD CONSTRAINT "cod_queue_items_escalated_by_users_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "cod_carrier_outcomes_tenant_isolation" ON "cod_carrier_outcomes" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cod_messages_tenant_isolation" ON "cod_messages" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);