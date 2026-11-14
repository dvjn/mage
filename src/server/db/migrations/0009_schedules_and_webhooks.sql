CREATE TABLE "schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"call_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"cron" text,
	"timezone" text,
	"prompt" text NOT NULL,
	"influence" json NOT NULL,
	"status" text NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "schedule_status_check" CHECK ("schedule"."status" in ('active', 'paused', 'completed', 'deleted')),
	CONSTRAINT "schedule_kind_check" CHECK (("schedule"."kind" = 'cron') = ("schedule"."cron" is not null and "schedule"."timezone" is not null)),
	CONSTRAINT "schedule_next_check" CHECK (("schedule"."status" <> 'active' or "schedule"."next_run_at" is not null)
          and ("schedule"."status" not in ('completed', 'deleted') or "schedule"."next_run_at" is null))
);
--> statement-breakpoint
CREATE TABLE "webhook" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"call_id" text,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"influence" json NOT NULL,
	"status" text NOT NULL,
	"token" text NOT NULL,
	"secret" "bytea",
	"secret_key_version" integer,
	"last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "webhook_status_check" CHECK ("webhook"."status" in ('active', 'paused', 'deleted'))
);
--> statement-breakpoint
-- Timers and schedules, and webhooks, from the table they shared: a timer that went off is
-- completed, and only an active or paused one keeps a next time.
DO $$
DECLARE misfit text;
BEGIN
  SELECT string_agg("id", ', ') INTO misfit FROM "thread_trigger"
   WHERE ("kind" = 'cron' AND "cron" IS NULL)
      OR ("kind" IN ('once', 'cron') AND "status" NOT IN ('active', 'paused', 'done', 'deleted'))
      OR ("kind" IN ('once', 'cron') AND "status" = 'active' AND "next_run_at" IS NULL)
      OR ("kind" = 'webhook' AND "status" NOT IN ('active', 'paused', 'deleted'))
      OR "kind" NOT IN ('once', 'cron', 'webhook');
  IF misfit IS NOT NULL THEN
    RAISE EXCEPTION 'triggers that fit neither a schedule nor a webhook: %', misfit;
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "schedule" ("id", "thread_id", "call_id", "kind", "name", "cron", "timezone", "prompt",
                        "influence", "status", "next_run_at", "last_fired_at", "created_at")
SELECT "id", "thread_id", "call_id", "kind", "name",
       CASE WHEN "kind" = 'cron' THEN "cron" END,
       CASE WHEN "kind" = 'cron' THEN coalesce("timezone", 'UTC') END,
       "prompt", "steered_by",
       CASE "status" WHEN 'done' THEN 'completed' ELSE "status" END,
       CASE WHEN "status" IN ('active', 'paused') THEN "next_run_at" END,
       "last_fired_at", "created_at"
  FROM "thread_trigger"
 WHERE "kind" IN ('once', 'cron');--> statement-breakpoint
INSERT INTO "webhook" ("id", "thread_id", "call_id", "name", "prompt", "influence", "status",
                       "token", "secret", "secret_key_version", "last_received_at", "created_at")
SELECT "id", "thread_id", "call_id", "name", "prompt", "steered_by", "status", "hook_token",
       "secret", "secret_key_version", "last_fired_at", "created_at"
  FROM "thread_trigger"
 WHERE "kind" = 'webhook';--> statement-breakpoint
DROP TABLE "thread_trigger" CASCADE;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook" ADD CONSTRAINT "webhook_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_call_idx" ON "schedule" USING btree ("thread_id","call_id") WHERE "schedule"."call_id" is not null;--> statement-breakpoint
CREATE INDEX "schedule_due_idx" ON "schedule" USING btree ("next_run_at") WHERE "schedule"."status" = 'active';--> statement-breakpoint
CREATE INDEX "schedule_thread_idx" ON "schedule" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_token_idx" ON "webhook" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_call_idx" ON "webhook" USING btree ("thread_id","call_id") WHERE "webhook"."call_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_thread_idx" ON "webhook" USING btree ("thread_id","created_at");