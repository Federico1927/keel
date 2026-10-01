ALTER TABLE "cod_operator_capacity" ADD COLUMN "allowed_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cod_queue_items" ADD COLUMN "entry_tag" text;