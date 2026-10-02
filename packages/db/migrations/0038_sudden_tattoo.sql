CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"livemode" boolean DEFAULT false NOT NULL,
	"tenant_ref" uuid,
	"object" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "billing_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"lookup_key" text NOT NULL,
	"kind" text NOT NULL,
	"item_key" text NOT NULL,
	"product_id" text NOT NULL,
	"price_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"interval" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pdf_url" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "subtotal_minor" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_minor" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "collection_method" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "next_payment_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "action_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "last_payment_error" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "einvoice_status" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "einvoice_ref" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "external_status" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "collection_method" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "payment_terms_days" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_email" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "payment_method_summary" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "checkout_url" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "checkout_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "checkout_items" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "customer_country" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "customer_tax_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "tax_exempt" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_dedup_uq" ON "billing_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "billing_events_status_idx" ON "billing_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "billing_events_received_idx" ON "billing_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_prices_provider_key_uq" ON "billing_prices" USING btree ("provider","lookup_key");--> statement-breakpoint
CREATE INDEX "billing_prices_price_idx" ON "billing_prices" USING btree ("price_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_external_uq" ON "invoices" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "subscriptions_external_customer_idx" ON "subscriptions" USING btree ("external_customer_id");--> statement-breakpoint
CREATE INDEX "subscriptions_external_sub_idx" ON "subscriptions" USING btree ("external_subscription_id");