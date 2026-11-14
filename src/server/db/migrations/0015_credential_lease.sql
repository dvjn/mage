ALTER TABLE "credential" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "lease_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_credential" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "mcp_credential" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_credential" ADD COLUMN "lease_epoch" integer DEFAULT 0 NOT NULL;