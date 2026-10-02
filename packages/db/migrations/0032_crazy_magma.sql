ALTER TABLE "discount_pools" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "assigned_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "assigned_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "redeemed_order_id" uuid;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "redeemed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_assigned_customer_id_customers_id_fk" FOREIGN KEY ("assigned_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_assigned_campaign_id_campaigns_id_fk" FOREIGN KEY ("assigned_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_redeemed_order_id_orders_id_fk" FOREIGN KEY ("redeemed_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;