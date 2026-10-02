CREATE TABLE "customer_prediction_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text NOT NULL,
	"params" jsonb,
	"customers" integer DEFAULT 0 NOT NULL,
	"log_likelihood" double precision,
	"calibration" jsonb,
	"duration_ms" integer,
	"fitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_prediction_models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customer_predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"p_alive" double precision NOT NULL,
	"expected_orders_90" double precision NOT NULL,
	"expected_orders_365" double precision NOT NULL,
	"expected_order_value_minor" integer NOT NULL,
	"predicted_value_365_minor" integer NOT NULL,
	"churn_risk" text NOT NULL,
	"next_order_at" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_predictions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_prediction_models" ADD CONSTRAINT "customer_prediction_models_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_predictions" ADD CONSTRAINT "customer_predictions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_predictions" ADD CONSTRAINT "customer_predictions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_prediction_models_tenant_uq" ON "customer_prediction_models" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_predictions_customer_uq" ON "customer_predictions" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_predictions_risk_idx" ON "customer_predictions" USING btree ("tenant_id","churn_risk");--> statement-breakpoint
CREATE POLICY "customer_prediction_models_tenant_isolation" ON "customer_prediction_models" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "customer_predictions_tenant_isolation" ON "customer_predictions" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);