CREATE TABLE "email_address_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" text NOT NULL,
	"email_masked" text NOT NULL,
	"reason" text NOT NULL,
	"source" text DEFAULT 'provider' NOT NULL,
	"provider_message_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"provider_message_id" text,
	"recipient_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bounce" text,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"template" text NOT NULL,
	"category" text NOT NULL,
	"kind" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"recipient_masked" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error" text,
	"expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_address_suppressions_uq" ON "email_address_suppressions" USING btree ("email_hash","reason");--> statement-breakpoint
CREATE UNIQUE INDEX "email_events_dedup_uq" ON "email_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "email_events_status_idx" ON "email_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_idempotency_uq" ON "email_messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "email_messages_created_idx" ON "email_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_messages_tenant_created_idx" ON "email_messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "email_messages_provider_id_idx" ON "email_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "email_messages_recipient_idx" ON "email_messages" USING btree ("recipient_hash");--> statement-breakpoint
CREATE POLICY "email_messages_tenant_select" ON "email_messages" AS PERMISSIVE FOR SELECT TO "keel_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "email_messages_tenant_insert" ON "email_messages" AS PERMISSIVE FOR INSERT TO "keel_app" WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);