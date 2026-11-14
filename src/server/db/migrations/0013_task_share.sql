CREATE TABLE "task_share" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"owner_thread_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_share" ADD CONSTRAINT "task_share_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_share" ADD CONSTRAINT "task_share_owner_thread_id_thread_id_fk" FOREIGN KEY ("owner_thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every subagent that works on its starter's list keeps doing so.
INSERT INTO "task_share" ("thread_id", "owner_thread_id")
SELECT "thread_id", "parent_thread_id" FROM "subagent" WHERE "share_tasks";--> statement-breakpoint
ALTER TABLE "subagent" DROP COLUMN "share_tasks";