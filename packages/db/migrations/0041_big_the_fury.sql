ALTER TABLE "retention_campaigns" ADD COLUMN "kind" text DEFAULT 'one_off' NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "exclude_open_orders" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "scheduled_by" uuid;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "exclusion_counts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "test_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD COLUMN "test_sent_by" uuid;--> statement-breakpoint
ALTER TABLE "retention_exposures" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "retention_exposures" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_exposures" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_exposures" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_exposures" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD COLUMN "identity_type" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD CONSTRAINT "retention_campaigns_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD CONSTRAINT "retention_campaigns_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD CONSTRAINT "retention_campaigns_scheduled_by_users_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_campaigns" ADD CONSTRAINT "retention_campaigns_test_sent_by_users_id_fk" FOREIGN KEY ("test_sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retention_campaigns_status_idx" ON "retention_campaigns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_exposures_idempotency_uq" ON "retention_exposures" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "retention_exposures_queue_idx" ON "retention_exposures" USING btree ("campaign_id","status");