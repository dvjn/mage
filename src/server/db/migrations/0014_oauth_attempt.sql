CREATE TABLE "oauth_attempt" (
	"state" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"flow" text NOT NULL,
	"subject_id" text NOT NULL,
	"holder" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"status" text NOT NULL,
	"result_id" text,
	"error" text,
	"next_poll_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "oauth_attempt_status_check" CHECK ("oauth_attempt"."status" in ('pending', 'completed', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE INDEX "oauth_attempt_due_idx" ON "oauth_attempt" USING btree ("next_poll_at") WHERE "oauth_attempt"."status" = 'pending' and "oauth_attempt"."flow" = 'device';