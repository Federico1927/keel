CREATE TABLE "product_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"external_id" text,
	"type" text DEFAULT 'image' NOT NULL,
	"url" text NOT NULL,
	"alt" text,
	"position" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "image_media_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "inventory_policy" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "tracks_inventory" boolean;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "requires_shipping" boolean;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "taxable" boolean;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "hs_code" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "country_of_origin" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "description_html" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "seo_title" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "seo_description" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category_name" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "collections" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "published_channels" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "metafields" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "platform_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_media_product_external_uq" ON "product_media" USING btree ("product_id","external_id");--> statement-breakpoint
CREATE INDEX "product_media_tenant_product_idx" ON "product_media" USING btree ("tenant_id","product_id","position");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_image_media_id_product_media_id_fk" FOREIGN KEY ("image_media_id") REFERENCES "public"."product_media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "product_media_tenant_isolation" ON "product_media" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);