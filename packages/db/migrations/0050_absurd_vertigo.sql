CREATE TABLE "tenant_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_ref" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"requested_by" uuid,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_steps" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_data_exports" ADD COLUMN "scope" text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_data_exports" ADD COLUMN "subject_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_data_exports" ADD COLUMN "subject" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_deletions" ADD CONSTRAINT "tenant_deletions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_deletions_tenant_idx" ON "tenant_deletions" USING btree ("tenant_ref","created_at");--> statement-breakpoint
CREATE INDEX "tenant_deletions_created_idx" ON "tenant_deletions" USING btree ("created_at");