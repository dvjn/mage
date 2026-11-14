ALTER TABLE "artifact_version" DROP CONSTRAINT "artifact_version_origin_check";--> statement-breakpoint
ALTER TABLE "artifact_version" DROP CONSTRAINT "artifact_version_run_id_run_id_fk";
--> statement-breakpoint
UPDATE "artifact_version" SET "call_id" = NULL
WHERE "call_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "call"
    WHERE "call"."thread_id" = "artifact_version"."thread_id" AND "call"."id" = "artifact_version"."call_id"
  );--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_thread_id_call_id_call_thread_id_id_fk" FOREIGN KEY ("thread_id","call_id") REFERENCES "public"."call"("thread_id","id") ON DELETE set null ("call_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version" DROP COLUMN "run_id";--> statement-breakpoint
ALTER TABLE "artifact_version" DROP COLUMN "background_call_id";
