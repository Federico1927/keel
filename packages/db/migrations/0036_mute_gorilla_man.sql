CREATE TABLE "ad_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"ad_set_id" uuid,
	"creative_id" uuid,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"asset_external_id" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"field_type" text DEFAULT 'other' NOT NULL,
	"text_content" text,
	"url" text,
	"performance_label" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ad_entity_metrics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"date" text NOT NULL,
	"grain" text DEFAULT 'day' NOT NULL,
	"spend_minor" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"reach" integer DEFAULT 0 NOT NULL,
	"conversions" double precision DEFAULT 0 NOT NULL,
	"conversion_value_minor" integer DEFAULT 0 NOT NULL,
	"video_views_3s" integer DEFAULT 0 NOT NULL,
	"video_completions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_entity_metrics_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ad_keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"ad_set_id" uuid,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"text" text NOT NULL,
	"match_type" text DEFAULT 'broad' NOT NULL,
	"quality_score" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"negative" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_keywords" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ad_search_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"ad_set_id" uuid,
	"keyword_id" uuid,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"text" text NOT NULL,
	"match_type" text,
	"status" text DEFAULT 'none' NOT NULL,
	"is_other" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_search_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ad_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"optimization_goal" text,
	"daily_budget_minor" integer,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "ad_set_id" uuid;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "final_url" text;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "url_tags" text;--> statement-breakpoint
ALTER TABLE "ad_assets" ADD CONSTRAINT "ad_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_assets" ADD CONSTRAINT "ad_assets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_assets" ADD CONSTRAINT "ad_assets_ad_set_id_ad_sets_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_assets" ADD CONSTRAINT "ad_assets_creative_id_ad_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."ad_creatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_entity_metrics_daily" ADD CONSTRAINT "ad_entity_metrics_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_entity_metrics_daily" ADD CONSTRAINT "ad_entity_metrics_daily_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_keywords" ADD CONSTRAINT "ad_keywords_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_keywords" ADD CONSTRAINT "ad_keywords_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_keywords" ADD CONSTRAINT "ad_keywords_ad_set_id_ad_sets_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_search_terms" ADD CONSTRAINT "ad_search_terms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_search_terms" ADD CONSTRAINT "ad_search_terms_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_search_terms" ADD CONSTRAINT "ad_search_terms_ad_set_id_ad_sets_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_search_terms" ADD CONSTRAINT "ad_search_terms_keyword_id_ad_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."ad_keywords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sets" ADD CONSTRAINT "ad_sets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sets" ADD CONSTRAINT "ad_sets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_assets_uq" ON "ad_assets" USING btree ("tenant_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "ad_assets_creative_idx" ON "ad_assets" USING btree ("tenant_id","creative_id");--> statement-breakpoint
CREATE INDEX "ad_assets_campaign_idx" ON "ad_assets" USING btree ("tenant_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_entity_metrics_daily_uq" ON "ad_entity_metrics_daily" USING btree ("entity_type","entity_id","grain","date");--> statement-breakpoint
CREATE INDEX "ad_entity_metrics_tenant_idx" ON "ad_entity_metrics_daily" USING btree ("tenant_id","entity_type","date");--> statement-breakpoint
CREATE INDEX "ad_entity_metrics_campaign_idx" ON "ad_entity_metrics_daily" USING btree ("tenant_id","campaign_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_keywords_uq" ON "ad_keywords" USING btree ("tenant_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "ad_keywords_campaign_idx" ON "ad_keywords" USING btree ("tenant_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_search_terms_uq" ON "ad_search_terms" USING btree ("tenant_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "ad_search_terms_campaign_idx" ON "ad_search_terms" USING btree ("tenant_id","campaign_id");--> statement-breakpoint
CREATE INDEX "ad_search_terms_text_idx" ON "ad_search_terms" USING btree ("tenant_id","text");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_sets_uq" ON "ad_sets" USING btree ("tenant_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "ad_sets_campaign_idx" ON "ad_sets" USING btree ("tenant_id","campaign_id");--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_ad_set_id_ad_sets_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "ad_assets_tenant_isolation" ON "ad_assets" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ad_entity_metrics_daily_tenant_isolation" ON "ad_entity_metrics_daily" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ad_keywords_tenant_isolation" ON "ad_keywords" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ad_search_terms_tenant_isolation" ON "ad_search_terms" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ad_sets_tenant_isolation" ON "ad_sets" AS PERMISSIVE FOR ALL TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);