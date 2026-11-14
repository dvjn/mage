ALTER TABLE "call" ADD COLUMN "moved_from" text;--> statement-breakpoint
-- A job a call became names it: the call's result says it moved, and to which job.
UPDATE "call" SET "moved_from" = e."data"->>'callId'
  FROM "thread_event" e
 WHERE e."type" = 'tool.ran'
   AND (e."data"->'value'->>'movedToBackground')::boolean IS TRUE
   AND "call"."thread_id" = e."thread_id"
   AND "call"."id" = e."data"->'value'->>'callId';
