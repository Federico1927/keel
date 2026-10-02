CREATE TABLE "return_exchange_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"return_line_id" uuid,
	"variant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "return_exchange_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "credit_bonus_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "exchange_difference_minor" integer;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "exchange_draft_id" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "exchange_invoice_url" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "voucher_platform_id" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "guarantee_auth_id" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "guarantee_status" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "guarantee_amount_minor" integer;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "guarantee_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "return_exchange_lines" ADD CONSTRAINT "return_exchange_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_exchange_lines" ADD CONSTRAINT "return_exchange_lines_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_exchange_lines" ADD CONSTRAINT "return_exchange_lines_return_line_id_return_lines_id_fk" FOREIGN KEY ("return_line_id") REFERENCES "public"."return_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_exchange_lines" ADD CONSTRAINT "return_exchange_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "return_exchange_lines_return_idx" ON "return_exchange_lines" USING btree ("tenant_id","return_id");--> statement-breakpoint
CREATE POLICY "return_exchange_lines_tenant_isolation" ON "return_exchange_lines" AS PERMISSIVE FOR ALL TO "hullwise_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);