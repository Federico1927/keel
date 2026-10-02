CREATE TABLE "cod_assignment_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"assigned_to" uuid,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cod_assignment_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cod_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"queue_item_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"operator_id" uuid,
	"attempt_number" integer NOT NULL,
	"outcome" text NOT NULL,
	"channel" text DEFAULT 'phone' NOT NULL,
	"note" text,
	"call_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cod_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cod_capacity_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date" text NOT NULL,
	"kind" text NOT NULL,
	"hours" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cod_capacity_exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cod_operator_capacity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"daily_hours" jsonb DEFAULT '[0,8,8,8,8,8,0]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cod_operator_capacity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cod_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"assigned_to" uuid,
	"assigned_at" timestamp with time zone,
	"attempts_count" integer DEFAULT 0 NOT NULL,
	"no_answer_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"call_back_at" timestamp with time zone,
	"score" integer,
	"score_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_tier" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cod_queue_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cod_recipient_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_key" text NOT NULL,
	"orders_total" integer DEFAULT 0 NOT NULL,
	"orders_delivered" integer DEFAULT 0 NOT NULL,
	"orders_returned" integer DEFAULT 0 NOT NULL,
	"weighted_returns" integer DEFAULT 0 NOT NULL,
	"consecutive_deliveries" integer DEFAULT 0 NOT NULL,
	"tier" text DEFAULT 'clean' NOT NULL,
	"override" text,
	"override_reason" text,
	"last_return_at" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"linked_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cod_recipient_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cod_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cod_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cod_assignment_log" ADD CONSTRAINT "cod_assignment_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_assignment_log" ADD CONSTRAINT "cod_assignment_log_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_assignment_log" ADD CONSTRAINT "cod_assignment_log_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_assignment_log" ADD CONSTRAINT "cod_assignment_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_attempts" ADD CONSTRAINT "cod_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_attempts" ADD CONSTRAINT "cod_attempts_queue_item_id_cod_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."cod_queue_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_attempts" ADD CONSTRAINT "cod_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_attempts" ADD CONSTRAINT "cod_attempts_operator_id_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_capacity_exceptions" ADD CONSTRAINT "cod_capacity_exceptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_capacity_exceptions" ADD CONSTRAINT "cod_capacity_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_operator_capacity" ADD CONSTRAINT "cod_operator_capacity_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_operator_capacity" ADD CONSTRAINT "cod_operator_capacity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD CONSTRAINT "cod_queue_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD CONSTRAINT "cod_queue_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD CONSTRAINT "cod_queue_items_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_recipient_profiles" ADD CONSTRAINT "cod_recipient_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_settings" ADD CONSTRAINT "cod_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cod_assignment_log_day_idx" ON "cod_assignment_log" USING btree ("tenant_id","assigned_to","assigned_at");--> statement-breakpoint
CREATE INDEX "cod_attempts_order_idx" ON "cod_attempts" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "cod_attempts_operator_idx" ON "cod_attempts" USING btree ("tenant_id","operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cod_capacity_exceptions_uq" ON "cod_capacity_exceptions" USING btree ("tenant_id","user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "cod_operator_capacity_user_uq" ON "cod_operator_capacity" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cod_queue_items_order_uq" ON "cod_queue_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "cod_queue_items_tenant_status_idx" ON "cod_queue_items" USING btree ("tenant_id","status","entered_at");--> statement-breakpoint
CREATE INDEX "cod_queue_items_assigned_idx" ON "cod_queue_items" USING btree ("tenant_id","assigned_to");--> statement-breakpoint
CREATE UNIQUE INDEX "cod_recipient_profiles_key_uq" ON "cod_recipient_profiles" USING btree ("tenant_id","recipient_key");--> statement-breakpoint
CREATE INDEX "cod_recipient_profiles_tier_idx" ON "cod_recipient_profiles" USING btree ("tenant_id","tier");--> statement-breakpoint
CREATE UNIQUE INDEX "cod_settings_tenant_uq" ON "cod_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "cod_assignment_log_tenant_isolation" ON "cod_assignment_log" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cod_attempts_tenant_isolation" ON "cod_attempts" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cod_capacity_exceptions_tenant_isolation" ON "cod_capacity_exceptions" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cod_operator_capacity_tenant_isolation" ON "cod_operator_capacity" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cod_queue_items_tenant_isolation" ON "cod_queue_items" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cod_recipient_profiles_tenant_isolation" ON "cod_recipient_profiles" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cod_settings_tenant_isolation" ON "cod_settings" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);