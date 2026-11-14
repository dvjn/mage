DROP INDEX "thread_input_key_idx";--> statement-breakpoint
ALTER TABLE "thread_input" DROP CONSTRAINT "thread_input_pkey";--> statement-breakpoint
ALTER TABLE "thread_input" ADD CONSTRAINT "thread_input_id_branch_id_pk" PRIMARY KEY("id","branch_id");--> statement-breakpoint
ALTER TABLE "subagent" ADD COLUMN "call_id" text;--> statement-breakpoint
ALTER TABLE "thread_input" ADD COLUMN "copy_of" text;--> statement-breakpoint
ALTER TABLE "thread_input" ADD COLUMN "source_call_id" text;--> statement-breakpoint
ALTER TABLE "thread_trigger" ADD COLUMN "call_id" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "seq" integer;--> statement-breakpoint
-- Where each call's request is in its thread's log.
UPDATE "call" SET "seq" = r."seq"
  FROM (SELECT DISTINCT ON ("thread_id", "data"->>'callId') "thread_id", "data"->>'callId' AS "id", "seq"
          FROM "thread_event" WHERE "type" = 'tool.requested'
         ORDER BY "thread_id", "data"->>'callId', "seq") r
 WHERE "call"."thread_id" = r."thread_id" AND "call"."id" = r."id";--> statement-breakpoint
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg("thread_id" || '/' || "id", ', ') INTO missing FROM "call" WHERE "seq" IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'calls with no tool.requested event in their thread: %', missing;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "call" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "thread_input_thread_key_idx" ON "thread_input" USING btree ("thread_id","key") WHERE "thread_input"."key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_input_key_idx" ON "thread_input" USING btree ("thread_id","branch_id","key") WHERE "thread_input"."key" is not null;--> statement-breakpoint
-- The call in its starter's thread that started each subagent: the first that answered with its
-- thread.
UPDATE "subagent" SET "call_id" = f."call_id"
  FROM (SELECT DISTINCT ON (e."thread_id", e."data"->'value'->>'id')
               e."thread_id", e."data"->'value'->>'id' AS "subagent", e."data"->>'callId' AS "call_id"
          FROM "thread_event" e
         WHERE e."type" = 'tool.ran' AND (e."data"->>'ok')::boolean IS TRUE
           AND e."data"->'value'->>'id' IS NOT NULL
         ORDER BY e."thread_id", e."data"->'value'->>'id', e."seq") f
 WHERE f."thread_id" = "subagent"."parent_thread_id" AND f."subagent" = "subagent"."thread_id";--> statement-breakpoint
-- The call that set each trigger: the first in its thread that answered with its id.
UPDATE "thread_trigger" SET "call_id" = f."call_id"
  FROM (SELECT DISTINCT ON (e."thread_id", e."data"->'value'->>'id')
               e."thread_id", e."data"->'value'->>'id' AS "trigger", e."data"->>'callId' AS "call_id"
          FROM "thread_event" e
         WHERE e."type" = 'tool.ran' AND (e."data"->>'ok')::boolean IS TRUE
           AND e."data"->'value'->>'id' IS NOT NULL
         ORDER BY e."thread_id", e."data"->'value'->>'id', e."seq") f
 WHERE f."thread_id" = "thread_trigger"."thread_id" AND f."trigger" = "thread_trigger"."id";--> statement-breakpoint
-- A row waiting on each thread's current branch for every notice it reads and has not taken in.
insert into thread_input (id, thread_id, branch_id, seq, kind, status, wake, origin_kind,
                          origin_id, created_at, copy_of, source_call_id)
select distinct on (e.id) e.id, e.thread_id, t.current_branch_id, e.seq, 'notice', 'waiting',
       i.wake, i.origin_kind, i.origin_id, i.created_at, i.copy_of, i.source_call_id
  from thread t
  join thread_branch_source s on s.branch_id = t.current_branch_id
  join thread_event e on e.thread_id = t.id and e.branch_id = s.source_branch_id
                     and (s.until_seq is null or e.seq <= s.until_seq)
  join thread_input i on i.thread_id = e.thread_id and i.id = e.id
 where e.type = 'notification'
   and not exists (
     select 1
       from thread_branch_source r
       join thread_event a on a.thread_id = t.id and a.branch_id = r.source_branch_id
                          and (r.until_seq is null or a.seq <= r.until_seq)
      where r.branch_id = t.current_branch_id and a.type = 'message.admitted'
        and exists (select 1 from json_array_elements_text(a.data->'messageIds') as m(id)
                     where m.id = e.id))
 order by e.id, (i.branch_id = t.current_branch_id) desc
on conflict do nothing;--> statement-breakpoint
-- What sent each notice still waiting: a job's own call, the call that set a schedule or webhook,
-- or the call that started a subagent that told its starter.
UPDATE "thread_input" SET "source_call_id" = "origin_id"
 WHERE "status" = 'waiting' AND "kind" = 'notice' AND "origin_kind" = 'job';--> statement-breakpoint
UPDATE "thread_input" SET "source_call_id" = s."call_id"
  FROM "subagent" s
 WHERE "thread_input"."status" = 'waiting' AND "thread_input"."kind" = 'notice'
   AND "thread_input"."origin_kind" = 'subagent'
   AND s."thread_id" = "thread_input"."origin_id" AND s."parent_thread_id" = "thread_input"."thread_id";--> statement-breakpoint
UPDATE "thread_input" SET "source_call_id" = g."call_id"
  FROM "thread_trigger" g
 WHERE "thread_input"."status" = 'waiting' AND "thread_input"."kind" = 'notice'
   AND "thread_input"."origin_kind" IN ('schedule', 'webhook')
   AND g."id" = "thread_input"."origin_id" AND g."thread_id" = "thread_input"."thread_id"
   AND g."call_id" IS NOT NULL;
