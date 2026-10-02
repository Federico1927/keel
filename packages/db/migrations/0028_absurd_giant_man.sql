CREATE TABLE "shipment_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"shipment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"shipment_status" text NOT NULL,
	"reason" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"resolution" text,
	"resolution_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"instruction_channel" text,
	"instruction_to" text,
	"instruction_ref" text,
	"instruction_sent_at" timestamp with time zone,
	"instruction_sent_by" uuid,
	"follow_ups" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"closed_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipment_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "packed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "packed_by" uuid;--> statement-breakpoint
ALTER TABLE "shipment_cases" ADD CONSTRAINT "shipment_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cases" ADD CONSTRAINT "shipment_cases_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cases" ADD CONSTRAINT "shipment_cases_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cases" ADD CONSTRAINT "shipment_cases_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cases" ADD CONSTRAINT "shipment_cases_instruction_sent_by_users_id_fk" FOREIGN KEY ("instruction_sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cases" ADD CONSTRAINT "shipment_cases_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_cases_open_uq" ON "shipment_cases" USING btree ("shipment_id","kind") WHERE closed_at is null;--> statement-breakpoint
CREATE INDEX "shipment_cases_tenant_queue_idx" ON "shipment_cases" USING btree ("tenant_id","kind","closed_at","opened_at");--> statement-breakpoint
CREATE INDEX "shipment_cases_order_idx" ON "shipment_cases" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_packed_by_users_id_fk" FOREIGN KEY ("packed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "shipment_cases_tenant_isolation" ON "shipment_cases" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);